import { Neovim } from '@chemzqm/neovim'
import OutputChannel from '../../model/outputChannel'
import { before, test } from 'node:test'
import assert from 'node:assert/strict'

let nvim: Neovim
let session: EditorSession
before(async () => {
  session = getSession()
  nvim = session.nvim
})

editorSuite('OutputChannel', () => {
  test('without nvim', t => {
    let o = new OutputChannel('f')
    o.appendLine('foo')
    o.append('bar')
    o.show()
    o.hide()
    o.clear()
  })

  test('channel name with special characters', async t => {
    let ch = new OutputChannel("a@b 'c", nvim)
    ch.show(false, 'edit')
    let bufname = await nvim.call('bufname', '%')
    assert.strictEqual(bufname, 'output:///a@b%20\'c')
    let bufnr = await nvim.call('bufnr', ['%'])
    ch.hide()
    await session.waitValue(() => nvim.call('bufloaded', [bufnr]), 0)
    let loaded = await nvim.call('bufloaded', [bufnr])
    assert.strictEqual(loaded, 0)
    ch.dispose()
  })

  test('outputChannel.show(true)', async t => {
    await nvim.setLine('foo')
    let c = new OutputChannel('0', nvim)
    let bufnr = (await nvim.buffer).id
    c.show(true)
    await session.waitFor('bufnr', ['%'], bufnr)
    c.hide()
    c.clear(1)
    c.dispose()
    c.append('')
    c.appendLine('')
  })

  test('outputChannel.keep()', async t => {
    let c = new OutputChannel('clear', nvim)
    c.show(false)
    await session.waitFor('bufname', ['%'], 'output:///clear')
    let buf = await nvim.buffer
    c.appendLine('foo')
    c.appendLine('bar')
    // appends land in the buffer before clear, so the keep assertion below
    // is not racing the buffer creation
    await session.waitFor('eval', [`join(getbufline(${buf.id},1,'$'),'\n')`], /bar/)
    c.clear(2)
    await session.waitFor('eval', [`join(getbufline(${buf.id},1,'$'),'\n')`], /bar/)
    let lines = await buf.lines
    assert.strictEqual(lines.includes('bar'), true)
  })

  test('outputChannel caps retained lines', async t => {
    let c = new OutputChannel('cap', nvim, undefined, 3)
    for (let i = 1; i <= 5; i++) c.appendLine(`${i}`)
    assert.deepStrictEqual(c.content.split('\n').filter(Boolean), ['4', '5'])
    c.dispose()
  })

  test('outputChannel trims buffer over cap', async t => {
    let c = new OutputChannel('trim', nvim, undefined, 3)
    c.show(false, 'edit')
    await session.waitFor('bufloaded', ['output:///trim'], 1)
    for (let i = 1; i <= 5; i++) c.appendLine(`${i}`)
    await session.waitFor('eval', [`join(getbufline('output:///trim',1,'$'),'\n')`], /5/)
    let lines = await nvim.call('getbufline', ['output:///trim', 1, '$']) as string[]
    assert.deepStrictEqual(lines.filter(Boolean), ['4', '5'])
    c.dispose()
  })

  test('outputChannel rewrites buffer on oversized burst append', async t => {
    let c = new OutputChannel('burst', nvim, undefined, 2)
    c.show(false, 'edit')
    await session.waitFor('bufloaded', ['output:///burst'], 1)
    c.appendLine('a\nb\nc\nd')
    await session.waitFor('eval', [`join(getbufline('output:///burst',1,'$'),'\n')`], /d/)
    assert.deepStrictEqual(c.content.split('\n').filter(Boolean), ['d'])
    let lines = await nvim.call('getbufline', ['output:///burst', 1, '$']) as string[]
    assert.deepStrictEqual(lines.filter(Boolean), ['d'])
    c.dispose()
  })

  test('outputChannel.show(false)', async t => {
    let c = new OutputChannel('1', nvim)
    let bufnr = (await nvim.buffer).id
    c.show()
    await session.waitFor('bufname', ['%'], 'output:///1')
    let nr = (await nvim.buffer).id
    assert.ok(bufnr < nr)
  })

  test('outputChannel.appendLine()', async t => {
    let c = new OutputChannel('2', nvim)
    c.show()
    await session.waitFor('bufname', ['%'], 'output:///2')
    let buf = await nvim.buffer
    c.appendLine('foo')
    await session.waitFor('eval', [`join(getbufline(${buf.id},1,'$'),'\n')`], /foo/)
  })

  test('outputChannel.append()', async t => {
    let c = new OutputChannel('3', nvim)
    c.show(false)
    await session.waitFor('bufname', ['%'], 'output:///3')
    let buf = await nvim.buffer
    c.append('foo')
    c.append('bar')
    await session.waitFor('eval', [`join(getbufline(${buf.id},1,'$'),'\n')`], /foo/)
  })

  test('outputChannel.clear()', async t => {
    let c = new OutputChannel('4', nvim)
    c.show(false)
    await session.waitFor('bufname', ['%'], 'output:///4')
    let buf = await nvim.buffer
    c.appendLine('foo')
    c.appendLine('bar')
    await session.waitFor('eval', [`join(getbufline(${buf.id},1,'$'),'\n')`], /bar/)
    c.clear()
    await session.waitValue(async () => (await buf.lines).join(''), '')
  })
})
