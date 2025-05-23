import { Neovim } from '@chemzqm/neovim'
import { Disposable, ParameterInformation, Range, SignatureInformation } from 'vscode-languageserver-protocol'
import commands from '../../commands'
import events from '../../events'
import Signature from '../../handler/signature'
import languages from '../../languages'
import { disposeAll } from '../../util'
import workspace from '../../workspace'
import helper from '../helper'

let nvim: Neovim
let signature: Signature
let disposables: Disposable[] = []

beforeAll(async () => {
  await helper.setup()
  nvim = helper.nvim
  signature = helper.plugin.getHandler().signature
})

afterAll(async () => {
  await helper.shutdown()
})

afterEach(async () => {
  await helper.reset()
  disposeAll(disposables)
  disposables = []
})

describe('signatureHelp', () => {

  describe('triggerSignatureHelp', () => {
    it('should show signature by api', async () => {
      let res = await signature.triggerSignatureHelp()
      expect(res).toBe(false)
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo()', 'my signature')],
            activeParameter: null,
            activeSignature: null
          }
        }
      }))
      await helper.createDocument()
      await nvim.input('foo')
      await commands.executeCommand('editor.action.triggerParameterHints')
      let win = await helper.getFloat()
      expect(win).toBeDefined()
      let lines = await helper.getWinLines(win.id)
      expect(lines[2]).toMatch('my signature')
    })

    it('should load configuration', async () => {
      await nvim.command(`edit +setl\\ buftype=nofile tree`)
      signature.loadConfiguration()
    })

    it('should use 0 when activeParameter is undefined', async () => {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo(a)', 'my signature', { label: 'a' })],
            activeParameter: undefined,
            activeSignature: null
          }
        }
      }, []))
      await helper.createDocument()
      await nvim.input('foo')
      await helper.doAction('showSignatureHelp')
      await signature.triggerSignatureHelp()
      let win = await helper.getFloat()
      expect(win).toBeDefined()
      let buf = await win.buffer
      let hls = await buf.getHighlights(-1 as any)
      expect(hls.length).toBe(2)
      expect(hls[0].hlGroup).toBe('CocFloatActive')
    })

    it('should trigger by space', async () => {
      let promise = new Promise(resolve => {
        disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
          provideSignatureHelp: (_doc, _position) => {
            resolve(undefined)
            return {
              signatures: [SignatureInformation.create('foo()', 'my signature')],
              activeParameter: null,
              activeSignature: null
            }
          }
        }, [' ']))
      })
      await helper.createDocument()
      await nvim.input('i')
      await helper.wait(30)
      await nvim.input(' ')
      await promise
    })

    it('should show signature help with param label as string', async () => {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [
              SignatureInformation.create('foo()', 'my signature'),
              SignatureInformation.create('foo', 'my signature', ParameterInformation.create('a', 'description')),
            ],
            activeParameter: 0,
            activeSignature: 1
          }
        }
      }, []))
      await helper.createDocument()
      await nvim.input('foo')
      await signature.triggerSignatureHelp()
      let win = await helper.getFloat()
      expect(win).toBeDefined()
      let lines = await helper.getWinLines(win.id)
      expect(lines.join('\n')).toMatch(/description/)
    })
  })

  describe('events', () => {
    function registProvider(): void {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo(x, y)', 'my signature')],
            activeParameter: 0,
            activeSignature: 0
          }
        }
      }, ['(', ',']))
    }

    it('should trigger signature help on TextInsert', async () => {
      registProvider()
      await helper.createDocument()
      await nvim.input('ifoo')
      await nvim.input('(')
      await helper.waitValue(async () => {
        let win = await helper.getFloat()
        return win != null
      }, true)
      let win = await helper.getFloat()
      let lines = await helper.getWinLines(win.id)
      expect(lines[2]).toMatch('my signature')
    })

    it('should trigger signature help on PlaceholderJump', async () => {
      let called = 0
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          called += 1
          return {
            signatures: [SignatureInformation.create('foo(x, y)', 'my signature')],
            activeParameter: 0,
            activeSignature: 0
          }
        }
      }, ['(', ',']))
      let doc = await helper.createDocument()
      Object.assign((workspace as any)._env, { jumpAutocmd: true })
      await events.fire('PlaceholderJump', [doc.bufnr, { charbefore: ' ', range: Range.create(0, 0, 0, 0) }])
      Object.assign((workspace as any)._env, { jumpAutocmd: false })
      await events.fire('PlaceholderJump', [doc.bufnr, { charbefore: '', range: Range.create(0, 0, 0, 0) }])
      await events.fire('PlaceholderJump', [doc.bufnr + 1, { charbefore: '(', range: Range.create(0, 0, 0, 0) }])
      expect(called).toBe(0)
      await nvim.input('ifoo(b)')
      await events.fire('PlaceholderJump', [doc.bufnr, { charbefore: '(', range: Range.create(0, 5, 0, 6) }])
      expect(called).toBe(1)
    })

    it('should cancel trigger on InsertLeave', async () => {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: async (_doc, _position, token) => {
          return new Promise(resolve => {
            let timer = setTimeout(() => {
              resolve({
                signatures: [SignatureInformation.create('foo()', 'my signature')],
                activeParameter: null,
                activeSignature: null
              })
            }, 1000)
            token.onCancellationRequested(() => {
              clearTimeout(timer)
              resolve(undefined)
            })
          })
        }
      }, ['(', ',']))
      await helper.createDocument()
      await nvim.input('foo')
      let p = signature.triggerSignatureHelp()
      await helper.wait(10)
      await nvim.command('stopinsert')
      await nvim.call('feedkeys', [String.fromCharCode(27), 'in'])
      let res = await p
      expect(res).toBe(false)
    })

    it('should not close signature on type', async () => {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo()', 'my signature')],
            activeParameter: null,
            activeSignature: null
          }
        }
      }, ['( ,']))
      let doc = await helper.createDocument()
      await nvim.input('foo(')
      await doc.synchronize()
      await nvim.input('bar')
      await doc.synchronize()
      await helper.waitFloat()
      let win = await helper.getFloat()
      let lines = await helper.getWinLines(win.id)
      expect(lines[2]).toMatch('my signature')
    })

    it('should close signature float when empty signatures returned', async () => {
      let empty = false
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          if (empty) return undefined
          return {
            signatures: [SignatureInformation.create('foo()', 'my signature')],
            activeParameter: null,
            activeSignature: null
          }
        }
      }, ['(', ',']))
      await helper.createDocument()
      await nvim.input('foo(')
      await helper.wait(100)
      let win = await helper.getFloat()
      expect(win).toBeDefined()
      empty = true
      await signature.triggerSignatureHelp()
      await helper.wait(50)
      let res = await nvim.call('coc#float#valid', [win.id])
      expect(res).toBe(0)
    })

    it('should close float on cursor moved', async () => {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo()', 'my signature')],
            activeParameter: null,
            activeSignature: null
          }
        }
      }, ['(', ',']))
      const show = async () => {
        await helper.createDocument()
        await nvim.input('i')
        await nvim.call('append', [1, 'bar'])
        await nvim.input('(')
        await helper.waitValue(async () => {
          let win = await helper.getFloat()
          return win != null
        }, true)
      }
      await show()
      await nvim.call('cursor', [2, 1])
      await helper.waitValue(async () => {
        let win = await helper.getFloat()
        return win == null
      }, true)
      await nvim.input('<esc>')
      await show()
      await nvim.input(')')
      await helper.waitValue(async () => {
        let win = await helper.getFloat()
        return win == null
      }, true)
    })
  })

  describe('float window', () => {
    it('should align signature window to top', async () => {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo()', 'my signature')],
            activeParameter: null,
            activeSignature: null
          }
        }
      }, ['(', ',']))
      await helper.createDocument()
      let buf = await nvim.buffer
      await buf.setLines(['', '', '', '', ''], { start: 0, end: -1, strictIndexing: true })
      await nvim.call('cursor', [5, 1])
      await nvim.input('foo(')
      await helper.wait(100)
      let win = await helper.getFloat()
      expect(win).toBeDefined()
      let lines = await helper.getWinLines(win.id)
      expect(lines[2]).toMatch('my signature')
      let res = await nvim.call('GetFloatCursorRelative', [win.id]) as any
      expect(res.row).toBeLessThan(0)
    })

    it('should show parameter docs', async () => {
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo(a, b)', 'my signature',
              ParameterInformation.create('a', 'foo'),
              ParameterInformation.create([7, 8], 'bar'))],
            activeParameter: 1,
            activeSignature: null
          }
        }
      }, ['(', ',']))
      await helper.createDocument()
      let buf = await nvim.buffer
      await buf.setLines(['', '', '', '', ''], { start: 0, end: -1, strictIndexing: true })
      await nvim.call('cursor', [5, 1])
      await nvim.input('foo(a,')
      await helper.wait(100)
      let win = await helper.getFloat()
      expect(win).toBeDefined()
      let lines = await helper.getWinLines(win.id)
      expect(lines.join('\n')).toMatch('bar')
    })
  })

  describe('configurations', () => {
    let { configurations } = workspace
    afterEach(() => {
      configurations.updateMemoryConfig({
        'signature.target': 'float',
        'signature.hideOnTextChange': false,
        'signature.enable': true,
        'signature.triggerSignatureWait': 500
      })
    })

    it('should cancel signature on timeout', async () => {
      configurations.updateMemoryConfig({ 'signature.triggerSignatureWait': 50 })
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position, token) => {
          return new Promise(resolve => {
            token.onCancellationRequested(() => {
              clearTimeout(timer)
              resolve(undefined)
            })
            let timer = setTimeout(() => {
              resolve({
                signatures: [SignatureInformation.create('foo()', 'my signature')],
                activeParameter: null,
                activeSignature: null
              })
            }, 200)
          })
        }
      }, ['(', ',']))
      await helper.createDocument()
      await signature.triggerSignatureHelp()
      let win = await helper.getFloat()
      expect(win).toBeUndefined()
      configurations.updateMemoryConfig({ 'signature.triggerSignatureWait': 100 })
    })

    it('should hide signature window on text change', async () => {
      configurations.updateMemoryConfig({ 'signature.hideOnTextChange': true })
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          let s = SignatureInformation.create('foo()', 'my signature')
          s.parameters = undefined
          return {
            signatures: [s],
            activeParameter: 0,
            activeSignature: null
          }
        }
      }, ['(', ',']))
      await helper.createDocument()
      await nvim.input('ifoo(')
      let winid = await helper.waitFloat()
      await nvim.input('x')
      await helper.wait(100)
      let res = await nvim.call('coc#float#valid', [winid])
      expect(res).toBe(0)
      configurations.updateMemoryConfig({ 'signature.hideOnTextChange': false })
    })

    it('should disable signature help trigger', async () => {
      configurations.updateMemoryConfig({ 'signature.enable': false })
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo()', 'my signature')],
            activeParameter: null,
            activeSignature: null
          }
        }
      }, ['(', ',']))
      await helper.createDocument()
      await nvim.input('foo')
      await nvim.input('(')
      await helper.wait(30)
      let win = await helper.getFloat()
      expect(win).toBeUndefined()
    })

    it('should echo simple signature help', async () => {
      let idx = 0
      let activeSignature = null
      configurations.updateMemoryConfig({ 'signature.target': 'echo' })
      disposables.push(languages.registerSignatureHelpProvider([{ scheme: 'file' }], {
        provideSignatureHelp: (_doc, _position) => {
          return {
            signatures: [SignatureInformation.create('foo(a, b)', 'my signature',
              ParameterInformation.create('a', 'foo'),
              ParameterInformation.create([7, 8], 'bar')),
            SignatureInformation.create('a'.repeat(workspace.env.columns + 10))
            ],
            activeParameter: idx,
            activeSignature
          }
        }
      }, []))
      await helper.createDocument()
      await nvim.input('foo(')
      await signature.triggerSignatureHelp()
      let line = await helper.getCmdline()
      expect(line).toMatch('(a, b)')
      await nvim.input('a,')
      idx = 1
      await signature.triggerSignatureHelp()
      line = await helper.getCmdline()
      expect(line).toMatch('foo(a, b)')
      activeSignature = 1
      await signature.triggerSignatureHelp()
      line = await helper.getCmdline()
      expect(line).toMatch('aaaaaa')
    })

    it('should echo signature without match', async () => {
      let signatureHelp = {
        signatures: [SignatureInformation.create('foo(a, b)', 'my signature',
          ParameterInformation.create('c', 'foo'),
          ParameterInformation.create([7, 8], 'bar')),
        SignatureInformation.create('a'.repeat(workspace.env.columns + 10))
        ],
        activeParameter: 0,
        activeSignature: null
      }
      signature.echoSignature(signatureHelp)
      await helper.wait(20)
      let line = await helper.getCmdline()
      expect(line).toMatch('foo')
      signatureHelp.signatures[0].parameters = undefined
      signature.echoSignature(signatureHelp)
    })
  })
})
