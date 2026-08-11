'use strict'

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = path.resolve(here, '../..')

// Only runner bookkeeping (LPT timings) lives on disk now; all compilation
// output stays in memory.
export const cacheDir = path.join(os.tmpdir(), 'coc-test-native')

// The editor-runtime bundle is built ONCE by the parent and written here;
// every test child requires this file directly (bundle.js.map next to it,
// linked via sourceMappingURL, keeps the JS file small). Inside the repo's
// gitignored .cache so the build never leaks into the worktree.
export const bundleFile = path.join(projectRoot, '.cache', 'coc-test', 'bundle.js')
