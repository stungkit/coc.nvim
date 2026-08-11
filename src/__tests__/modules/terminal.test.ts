import { Neovim } from '@chemzqm/neovim'
import { TerminalModel } from '../../model/terminal'
import { afterEach, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

let nvim: Neovim
let terminal: TerminalModel
let session: EditorSession
before(async () => {
  session = getSession()
  nvim = session.nvim
})

beforeEach(async () => {
  terminal = new TerminalModel('sh', [], nvim)
  await terminal.start(import.meta.dirname, { COC_TERMINAL: `option '-term'` })
})

afterEach(() => {
  terminal.dispose()
})

describe('terminal properties', () => {
  it('should get name', t => {
    let name = terminal.name
    assert.strictEqual(name, 'sh')
  })

  it('should have correct cwd and env', async t => {
    let bufnr = terminal.bufnr
    terminal.sendText('echo $PWD')
    await session.waitFor('eval', [`join(getbufline(${bufnr},1,'$'),'\n')`], /\S/)
    let lines = await nvim.call('getbufline', [bufnr, 1, '$']) as string[]
    assert.ok(lines[0].trim().length > 0)
    terminal.sendText('echo $COC_TERMINAL')
    await session.waitFor('eval', [`join(getbufline(${bufnr},1,'$'),'\n')`], /option '-term'/)
    lines = await nvim.call('getbufline', [bufnr, 1, '$']) as string[]
    assert.strictEqual(lines.includes(`option '-term'`), true)
    terminal.onExit(-1)
  })

  it('should get pid', async t => {
    let pid = await terminal.processId
    assert.strictEqual(typeof pid, 'number')
  })

  it('should hide terminal window', async t => {
    await terminal.hide()
    let winnr = await nvim.call('bufwinnr', terminal.bufnr)
    assert.strictEqual(winnr, -1)
  })

  it('should show terminal window', async t => {
    await terminal.show()
    let winnr = await nvim.call('bufwinnr', terminal.bufnr)
    assert.strictEqual(winnr != -1, true)
  })

  it('should  not throw when not shown', async t => {
    let terminal = new TerminalModel('sh', [], nvim)
    t.after(() => terminal.dispose())
    terminal.sendText('text')
    await terminal.start(import.meta.dirname, {})
    await terminal.show()
    await terminal.show()
  })
})
