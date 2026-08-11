'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {threadId} = require('node:worker_threads')

if (global.__TEST__ === undefined) {
  global.__TEST__ = true
  const runId = process.env.COC_TEST_LANE || 'local'
  // Each child process or worker thread gets its own data home. Worker
  // threads share a PID, so threadId is required to avoid file races.
  // Keep the data home under the runner's dedicated temp base
  // (coc-test-native); unit tests use `os.tmpdir()/coc-test` for their own
  // scratch dirs and must never overlap with runner state.
  const dataHome = path.join(os.tmpdir(), 'coc-test-native', runId, `${process.pid}-${threadId}`)
  fs.mkdirSync(path.join(dataHome, 'mcp'), {recursive: true})
  fs.mkdirSync(path.join(dataHome, 'vimconfig'), {recursive: true})
  process.env.NODE_ENV = 'test'
  process.env.COC_NVIM = '1'
  process.env.VIMRUNTIME = ''
  process.env.COC_DATA_HOME = dataHome
  process.env.XDG_RUNTIME_DIR = dataHome
  process.env.COC_MCP_DIR = path.join(dataHome, 'mcp')
  process.env.COC_VIMCONFIG = path.join(dataHome, 'vimconfig')
  process.env.NVIM_LOG_FILE = path.join(dataHome, 'nvim.log')
  process.on('exit', () => {
    fs.rmSync(dataHome, {recursive: true, force: true})
  })
}

// Bind the editor-runtime bundle on the global so the module customization
// hooks (bundle-hooks.mjs) can route src imports to bundle objects. The
// bundle file is built once by the runner parent and required directly —
// children never build it. Unit children load no editor session, so they
// skip binding it here and the hooks require the file lazily on their first
// src import.
if (process.env.COC_TEST_LANE !== 'unit' && globalThis.__cocBundle) {
  // Expose the bundled test runtime (EditorSession/editorSuite/registry) as
  // globals so nvim-lane test files use them without importing any file
  // from src/__tests__. Types live in src/__tests__/global.d.ts.
  const testNs = globalThis.__cocBundle['test/editorSession']
  if (testNs) {
    globalThis.EditorSession = testNs.EditorSession
    globalThis.editorSuite = testNs.editorSuite
    globalThis.getSession = testNs.getSession
    globalThis.setSession = testNs.setSession
    globalThis.createTmpFile = testNs.createTmpFile
  }
}
