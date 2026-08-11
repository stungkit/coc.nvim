'use strict'

// Test runtime infrastructure for the nvim lane, moved out of src/__tests__
// and bundled into bundle.js (exposed on globalThis by preload.cjs). Every
// non-unit test file now runs in its own child process with its own editor
// runtime, so nothing is shared between files except this module.

import * as cp from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import {describe} from 'node:test'
import {Disposable} from 'vscode-languageserver-protocol'

// Editor runtime bundle: full-path keyed and lazy, bound by preload.cjs so
// module instances (workspace, events, ...) are the same ones the tests
// import from the bundle.
const bundle = globalThis.__cocBundle
const {terminate} = bundle['src/util/processes']

// The vimrc computes its root from `<sfile>` (`:h:h:h`), so a copy inside
// the build tree would resolve to the build dir instead of the repo root.
// Always use the source-tree vimrc; the project root is passed explicitly
// (the temp build tree is no longer three levels under the repository).
const projectRoot = process.env.COC_TEST_ROOT || process.cwd()
const vimrc = path.join(projectRoot, 'src', '__tests__', 'vimrc')

// Where nvim starts and where relative `:edit` paths land. There is no build
// tree anymore (everything compiles in memory), so tests run from the source
// test directory; fixtures (test.zip, sample/, ...) live there too.
const nvimCwd = path.join(projectRoot, 'src', '__tests__')

function getAttach() {
  return bundle['src/attach'].default
}

function getEvents() {
  return bundle['src/events'].default
}

/**
 * One editor runtime per test file: spawns neovim, attaches the coc runtime
 * from the bundle and manages per-test reset/dispose.
 */
export class EditorSession {
  constructor() {
    this.proc = undefined
    this.server = undefined
    this.plugin = undefined
  }

  get workspace() {
    if (!this.plugin || !this.plugin.workspace) throw new Error('session not attached')
    return this.plugin.workspace
  }

  get completion() {
    if (!this.plugin || !this.plugin.completion) throw new Error('session not attached')
    return this.plugin.completion
  }

  get nvim() {
    return this.plugin.nvim
  }

  async start(kind = 'nvim') {
    if (this.plugin) return
    if (kind === 'vim') {
      await this.startVim()
    } else {
      await this.startNvim()
    }
    await this.plugin.init('')
  }

  async startNvim() {
    let proc = this.proc = cp.spawn(process.env.NVIM_COMMAND ?? 'nvim', ['-u', vimrc, '-i', 'NONE', '--embed'], {
      cwd: nvimCwd
    })
    proc.unref()
    this.plugin = getAttach()({proc})
    await this.nvim.uiAttach(160, 80, {})
    this.nvim.call('coc#rpc#set_channel', [1], true)
    this.nvim.on('vim_error', err => {
      if (typeof err === 'string' && err.startsWith('Lua')) {
        console.error('Error from vim: ', err)
      }
    })
  }

  async startVim() {
    if (process.env.VIM_NODE_RPC != '1') {
      throw new Error('VIM_NODE_RPC should be 1')
    }
    let promise = new Promise(resolve => {
      this.server = net.createServer(socket => {
        this.plugin = getAttach()({reader: socket, writer: socket})
        this.nvim.on('vim_error', err => {
          console.error('Error from vim: ', err)
        })
        resolve()
      })
    })
    let address = await this.listenOnVim(this.server)
    let proc = this.proc = cp.spawn(process.env.VIM_COMMAND ?? 'vim', ['--clean', '--not-a-term', '-u', vimrc], {
      stdio: 'pipe',
      cwd: nvimCwd,
      env: {
        COC_NVIM_REMOTE_ADDRESS: address,
        ...process.env
      }
    })
    proc.on('error', err => {
      console.error(err)
    })
    proc.on('exit', code => {
      if (code) console.error('vim exit with code ' + code)
    })
    await promise
  }

  async listenOnVim(server) {
    const isWindows = process.platform === 'win32'
    if (!isWindows) {
      try {
        const socket = path.join(os.tmpdir(), `coc-test-${crypto.randomUUID()}.sock`)
        return await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(socket, () => {
            server.removeListener('error', reject)
            server.unref()
            resolve(socket)
          })
        })
      } catch (e) {
        // fall through to TCP
      }
    }
    return await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        let port = server.address().port
        server.unref()
        resolve(`127.0.0.1:${port}`)
      })
    })
  }

  async reset() {
    // let mode = await this.nvim.mode
    // if (mode.blocking && mode.mode == 'r') {
    //   // await this.nvim.input('<cr>')
    // } else if (mode.mode != 'n' || mode.blocking) {
    //   // await this.nvim.call('feedkeys', [String.fromCharCode(27), 'in'])
    // }
    // A test aborted while waiting on a dialog prompt leaves
    // coc#dialog#prompt_confirm blocked in getchar(); its RPC promise and the
    // Dialogs mutex never settle until a key is fed. Dismiss it so later
    // tests can use dialogs again.
    await this.nvim.input('<esc>')
    this.completion.cancelAndClose()
    this.workspace.reset()
    this.nvim.pauseNotification()
    // this.nvim.command('call feedkeys("\\<esc>", "in")', true)
    this.nvim.call('coc#float#close_all', [], true)
    this.nvim.command('silent! %bwipeout! | setl nopreviewwindow', true)
    await this.nvim.resumeNotification()
    await this.workspace.document
  }

  async stop() {
    const plugin = this.plugin
    const server = this.server
    const proc = this.proc
    this.plugin = undefined
    this.server = undefined
    this.proc = undefined
    // Each test file owns its editor process, so there is no state to
    // preserve here. End the editor immediately instead of waiting for a
    // graceful RPC quit; terminate() also cleans up editor child processes.
    if (server) server.close()
    if (proc) terminate(proc)
    if (plugin) {
      // Deliberately do NOT call plugin.dispose(): it tears down bundle
      // singletons and leaves language client IPC sockets half-closed, which
      // hangs the child process. Stop registered services explicitly after
      // ending the editor so their sockets/forks cannot keep the test child
      // alive.
      const services = bundle['src/services'].default
      try {
        await services.stopAll()
      } catch (e) {
        console.error('EditorSession.stopAll error', e)
      }
    }
  }

  wait(ms = 30) {
    return new Promise(resolve => {
      setTimeout(() => resolve(), ms)
    })
  }

  async waitValue(fn, value) {
    let find = false
    for (let i = 0; i < 200; i++) {
      // Let pending I/O and promise continuations settle before the first
      // check without paying a fixed 20ms for values that are already ready.
      // Keep the existing polling interval after a miss to avoid a busy loop.
      if (i === 0) await new Promise(resolve => setImmediate(resolve))
      else await this.wait(20)
      let res = await Promise.resolve(fn())
      // A single event-loop turn can expose an intermediate editor state.
      // Confirm an immediately-ready value once more before returning; a
      // changed value falls back to the established 20ms polling cadence.
      if (i === 0 && util.isDeepStrictEqual(res, value)) {
        await new Promise(resolve => setImmediate(resolve))
        res = await Promise.resolve(fn())
      }
      if (util.isDeepStrictEqual(res, value)) {
        find = true
        break
      }
    }
    if (!find) {
      throw new Error(`waitValue ${value} timeout`)
    }
  }

  async waitFor(method, args, value) {
    let find = false
    let res
    for (let i = 0; i < 100; i++) {
      if (i === 0) await new Promise(resolve => setImmediate(resolve))
      else await this.wait(20)
      res = await this.nvim.call(method, args)
      let matched = util.isDeepStrictEqual(res, value) || (value instanceof RegExp && value.test(res.toString()))
      if (i === 0 && matched) {
        await new Promise(resolve => setImmediate(resolve))
        res = await this.nvim.call(method, args)
        matched = util.isDeepStrictEqual(res, value) || (value instanceof RegExp && value.test(res.toString()))
      }
      if (matched) {
        find = true
        break
      }
    }
    if (!find) {
      throw new Error(`waitFor ${value} timeout, current: ${res}`)
    }
  }

  async waitNotification(event) {
    return new Promise((resolve, reject) => {
      let fn = method => {
        if (method == event) {
          clearTimeout(timer)
          this.nvim.removeListener('notification', fn)
          resolve()
        }
      }
      let timer = setTimeout(() => {
        this.nvim.removeListener('notification', fn)
        reject(new Error('wait notification timeout after 2s'))
      }, 2000)
      this.nvim.on('notification', fn)
    })
  }

  async waitPrompt() {
    if (await this.nvim.call('coc#prompt#activated')) return
    for (let i = 0; i < 60; i++) {
      await this.wait(30)
      let prompt = await this.nvim.call('coc#prompt#activated')
      if (prompt) return
    }
    throw new Error('Wait prompt timeout after 2s')
  }

  async waitPromptWin() {
    let winid = await this.nvim.call('coc#dialog#get_prompt_win')
    if (winid != -1) return winid
    for (let i = 0; i < 60; i++) {
      await this.wait(30)
      let winid = await this.nvim.call('coc#dialog#get_prompt_win')
      if (winid != -1) return winid
    }
    throw new Error('Wait prompt window timeout after 2s')
  }

  async waitFloat() {
    let winid = await this.nvim.call('GetFloatWin')
    if (winid) return winid
    for (let i = 0; i < 50; i++) {
      await this.wait(20)
      let winid = await this.nvim.call('GetFloatWin')
      if (winid) return winid
    }
    throw new Error('timeout after 2s')
  }

  async waitPopup() {
    let visible = await this.nvim.call('coc#pum#visible')
    if (visible) return
    let res = await getEvents().race(['MenuPopupChanged'], 8000)
    if (!res) throw new Error('wait pum timeout after 8s')
  }

  async doAction(method, ...args) {
    return await this.plugin.cocAction(method, ...args)
  }

  async items() {
    return this.completion?.activeItems.slice()
  }

  async confirmCompletion(idx) {
    await this.nvim.call('coc#pum#select', [idx, 1, 1])
  }

  async visible(word, source) {
    await this.waitPopup()
    let items = this.completion.activeItems
    if (!items) return false
    let item = items.find(o => o.word == word)
    if (!item) return false
    if (source && item.source.name != source) return false
    return true
  }

  async edit(file) {
    if (!file || !path.isAbsolute(file)) {
      file = path.join(nvimCwd, file ? file : `${crypto.randomUUID()}`)
    }
    let escaped = await this.nvim.call('fnameescape', file)
    await this.nvim.command(`edit ${escaped}`)
    let doc = await this.workspace.document
    return doc.buffer
  }

  async createDocument(name) {
    let buf = await this.edit(name)
    let doc = this.workspace.getDocument(buf.id)
    if (!doc) return await this.workspace.document
    return doc
  }

  async listInput(input) {
    await getEvents().fire('InputChar', ['list', input, 0])
  }

  async getCmdline(lnum) {
    let str = ''
    let n = await this.nvim.eval('&lines')
    for (let i = 1, l = 70; i < l; i++) {
      let ch = await this.nvim.call('screenchar', [lnum ?? n - 1, i])
      if (ch == -1) break
      str += String.fromCharCode(ch)
    }
    return str.trim()
  }

  updateConfiguration(key, value, disposables) {
    let curr = this.workspace.getConfiguration(key)
    let {configurations} = this.workspace
    configurations.updateMemoryConfig({[key]: value})
    let fn = () => {
      configurations.updateMemoryConfig({[key]: curr})
    }
    if (disposables) disposables.push(Disposable.create(fn))
    return fn
  }

  async getMatches(hlGroup) {
    let res = await this.nvim.call('getmatches')
    let list = []
    res.forEach(o => {
      if (o.group === hlGroup) {
        for (const [key, value] of Object.entries(o)) {
          if (key.startsWith('pos')) {
            list.push(value)
          }
        }
      }
    })
    return list
  }

  async mockFunction(name, result) {
    let content = `
    function! ${name}(...)
      return ${typeof result == 'number' ? result : JSON.stringify(result)}
    endfunction`
    await this.nvim.exec(content)
  }

  async getFloat(kind) {
    if (!kind) {
      let ids = await this.nvim.call('coc#float#get_float_win_list')
      return ids.length ? this.nvim.createWindow(ids[0]) : undefined
    } else {
      let id = await this.nvim.call('coc#float#get_float_by_kind', [kind])
      return id ? this.nvim.createWindow(id) : undefined
    }
  }

  async getWinLines(winid) {
    return await this.nvim.eval(`getbufline(winbufnr(${winid}), 1, '$')`)
  }

  createNullChannel() {
    return {
      content: '',
      show: () => {},
      dispose: () => {},
      name: 'null',
      append: () => {},
      appendLine: () => {},
      clear: () => {},
      hide: () => {}
    }
  }
}

export async function createTmpFile(content, disposables) {
  let tmpFolder = path.join(os.tmpdir(), `coc-${process.pid}`)
  if (!fs.existsSync(tmpFolder)) {
    fs.mkdirSync(tmpFolder)
  }
  let fsPath = path.join(tmpFolder, crypto.randomUUID())
  await util.promisify(fs.writeFile)(fsPath, content, 'utf8')
  if (disposables) {
    disposables.push(Disposable.create(() => {
      if (fs.existsSync(fsPath)) fs.unlinkSync(fsPath)
    }))
  }
  return fsPath
}

let current

export function setSession(session) {
  current = session
}

export function getSession() {
  if (!current) throw new Error('editor session not started')
  return current
}

/**
 * Suite wrapper for tests running inside a dedicated editor runtime. The
 * entry starts one EditorSession per test file and resets it once between
 * leaf tests.
 */
export function editorSuite(name, fn) {
  describe(name, fn)
}
