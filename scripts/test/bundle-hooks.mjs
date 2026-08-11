// @ts-check
// Module customization hooks (node:module registerHooks, Node >= 22.9) that
// make the whole test runtime compile **in memory** — nothing is written to
// disk:
// - every src/__tests__ TypeScript file (tests + infra like unit/testUtils)
//   is compiled to ESM in memory (esbuild write:false) and served here;
// - when a test file itself is loaded (it is now the runner entry, passed to
//   node:test by its real source path), the hooks derive its lane from the
//   path, set the lane env and inject the preload / EditorSession wrapper
//   that the old virtual /coc-entry module used to provide;
// - every import of a coc.nvim src module is routed to the editor-runtime
//   bundle file (`.cache/coc-test/bundle.js`, built once by the parent and
//   required directly — never rebuilt here), so plugin/workspace/window/...
//   singletons stay identical across the whole test process without
//   rewriting imports.
//
// The bundle object is bound on `globalThis.__cocBundle` (by preload for the
// editor lanes, or lazily here on the first src import).
import {builtinModules, createRequire, registerHooks} from 'node:module'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import {buildSync} from 'esbuild'
import {bundleFile, projectRoot} from './paths.mjs'
import {VIM_TESTS} from './discover.mjs'

const require = createRequire(import.meta.url)

const TEST_TS_RE = new RegExp(
  `^file://${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/src/__tests__/.*\\.ts$`
)
const compiled = new Map()
const preloadPath = path.join(projectRoot, 'scripts', 'test', 'preload.cjs')

/**
 * Lane is decided purely by the test file path (same rule as
 * discover.mjs): the unit directory is unit, VIM_TESTS is vim, everything
 * else is nvim.
 */
function laneForFile(rel) {
  if (rel.startsWith('src' + path.sep + '__tests__' + path.sep + 'unit' + path.sep)) return 'unit'
  if (VIM_TESTS.includes(rel)) return 'vim'
  return 'nvim'
}

/**
 * Main-module source for an editor-lane test file. node:test runs sibling
 * top-level before hooks concurrently (a before hook would race the test
 * file's own `before` calling getSession()), so mirror the old entry
 * structure instead: an outer describe starts/stops one EditorSession and
 * imports the real test file inside it — its hooks/tests are then gated by
 * the outer before. The test file is imported with a `?raw` query: the plain
 * URL is this wrapper itself, so the raw URL gives the test module a
 * distinct identity (and import.meta.dirname still resolves correctly).
 */
function editorEntrySource(lane, rel) {
  const kind = lane === 'vim' ? 'vim' : 'nvim'
  const rawUrl = 'file://' + path.join(projectRoot, rel) + '?raw'
  return `import { after, before, beforeEach, describe } from 'node:test'
const __cocTestSession = new globalThis.EditorSession()
let __cocTestStarted = false
describe(${JSON.stringify(rel)}, async () => {
  before(async () => { await __cocTestSession.start(${JSON.stringify(kind)}); globalThis.setSession(__cocTestSession) }, { timeout: 15000 })
  beforeEach(async () => {
    if (__cocTestStarted) await __cocTestSession.reset()
    else __cocTestStarted = true
  })
  after(async () => { await __cocTestSession.stop() }, { timeout: 10000 })
  await import(${JSON.stringify(rawUrl)})
})
`
}

let bundleObj = globalThis.__cocBundle
function ensureBundle() {
  if (bundleObj) return bundleObj
  if (!fs.existsSync(bundleFile)) {
    throw new Error(`coc-test: editor-runtime bundle not found at ${bundleFile} — run the tests through scripts/test/cli.mjs`)
  }
  bundleObj = globalThis.__cocBundle = require(bundleFile)
  return bundleObj
}

function srcKeyFor(resolved) {
  const rel = path.relative(projectRoot, resolved)
  if (!rel || rel.startsWith('..')) return undefined
  if (!rel.startsWith('src')) return undefined
  if (rel.startsWith('src' + path.sep + '__tests__')) return undefined
  const withoutExt = rel.endsWith('.ts') ? rel.slice(0, -3) : rel
  for (const candidate of [withoutExt, path.join(withoutExt, 'index')]) {
    if (fs.existsSync(path.join(projectRoot, candidate + '.ts'))) {
      return candidate.split(path.sep).join('/')
    }
  }
  return undefined
}

function compileTest(url) {
  if (compiled.has(url)) return compiled.get(url)
  const srcPath = fileURLToPath(url)
  const result = buildSync({
    entryPoints: [srcPath],
    // Never bundle: third-party packages, node builtins and src imports all
    // stay as runtime import statements. Node (with these hooks) resolves
    // them at load time — src modules to the editor bundle, third-party
    // packages to their CJS build via `coc-pkg:` so instances stay shared
    // with the bundle.
    bundle: false,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    target: 'node24',
    write: false,
    sourcemap: 'inline',
    sourcesContent: true,
    tsconfig: path.join(projectRoot, 'tsconfig.test.json'),
    logLevel: 'silent',
  })
  let output = result.outputFiles[0].text
  // esbuild emits sources relative to the project root; Node resolves a
  // relative source against the module URL's directory, which would double
  // the path for source-tree URLs. Rewrite them as absolute file URLs.
  const mapMatch = output.match(/sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/)
  if (mapMatch) {
    const map = JSON.parse(Buffer.from(mapMatch[1], 'base64').toString('utf8'))
    map.sources = map.sources.map(s => 'file://' + path.resolve(projectRoot, s))
    output = output.replace(
      mapMatch[0],
      'sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64')
    )
  }
  // A handful of test files call require() directly (no ESM prologue is
  // injected); give them a local createRequire only. __dirname/__filename
  // were replaced by import.meta.dirname/import.meta.filename in the tests.
  const rel = path.relative(projectRoot, srcPath)
  const source = REQUIRES_DIRECT.has(rel)
    ? "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" + output
    : output
  compiled.set(url, source)
  return source
}

// Test files that call require() at runtime and get a targeted require
// injection; everything else compiles as plain ESM.
const REQUIRES_DIRECT = new Set([
  'src/__tests__/unit/factory.test.ts',
  'src/__tests__/unit/modules-util.test.ts',
  'src/__tests__/handler/workspace.test.ts',
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('coc-bundle:')) {
      return {url: specifier, shortCircuit: true}
    }
    if (specifier.endsWith('?raw') && TEST_TS_RE.test(specifier.slice(0, -4))) {
      return {url: specifier, shortCircuit: true}
    }
    if (TEST_TS_RE.test(specifier)) {
      return {url: specifier, shortCircuit: true}
    }
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      const parent = fileURLToPath(context.parentURL.endsWith('?raw') ? context.parentURL.slice(0, -4) : context.parentURL)
      const resolved = path.resolve(path.dirname(parent), specifier)
      const key = srcKeyFor(resolved)
      if (key) {
        return {url: `coc-bundle:${key}`, shortCircuit: true}
      }
      // src/__tests__ infra (testUtils, ...) is compiled in memory too;
      // resolve the extensionless import to its .ts file.
      const rel = path.relative(projectRoot, resolved)
      if (rel.startsWith('src' + path.sep + '__tests__')) {
        const ts = resolved.endsWith('.ts') ? resolved : resolved + '.ts'
        if (fs.existsSync(ts)) {
          return {url: 'file://' + ts, shortCircuit: true}
        }
      }
      return nextResolve(specifier, context)
    }
    // Third-party packages imported by in-memory test modules:
    // packages bundled into the runtime are routed to the bundle's `pkg:<spec>`
    // export so tests reference the exact instance the bundle uses instead of
    // loading node_modules again. Anything not in the bundle (test-only deps)
    // falls back to the repository node_modules.
    if (context.parentURL &&
      !specifier.startsWith('node:') && !builtinModules.includes(specifier) &&
      !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      const parentTestUrl = context.parentURL.endsWith('?raw') ? context.parentURL.slice(0, -4) : context.parentURL
      const parentIsTest = TEST_TS_RE.test(parentTestUrl)
      if (parentIsTest) {
        ensureBundle()
        if (bundleObj[`pkg:${specifier}`] !== undefined) {
          return {url: `coc-bundle:pkg:${specifier}`, shortCircuit: true}
        }
        try {
          const resolved = require.resolve(specifier, {paths: [projectRoot]})
          if (resolved !== specifier) {
            return {url: 'coc-pkg:' + resolved, shortCircuit: true}
          }
        } catch {
          // fall through to default resolution
        }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('coc-bundle:')) {
      ensureBundle()
      const key = url.slice('coc-bundle:'.length)
      const ns = bundleObj[key]
      if (!ns) {
        throw new Error(`coc-test: bundle module not found: ${key}`)
      }
      // ESM static named imports need statically declared exports, so emit
      // explicit `export const` bindings from the (CJS) bundle namespace
      // instead of returning a CJS module (which cjs-module-lexer cannot
      // introspect for this dynamic assignment).
      const lines = [`const __cocNs = globalThis.__cocBundle[${JSON.stringify(key)}]`]
      for (const name of Object.keys(ns)) {
        if (name === 'default') continue
        lines.push(`export const ${name} = __cocNs[${JSON.stringify(name)}]`)
      }
      // CJS packages whose module.exports is a callable (e.g. `which`) have
      // no `default` key on the namespace; fall back to the namespace itself.
      lines.push('export default __cocNs.default !== undefined ? __cocNs.default : __cocNs')
      return {
        format: 'module',
        source: lines.join('\n'),
        shortCircuit: true,
      }
    }
    // The editor wrapper imports the same test file under a `?raw` URL so it
    // gets a distinct module identity; both forms compile the real file.
    const isRaw = url.endsWith('?raw')
    const testUrl = isRaw ? url.slice(0, -4) : url
    if (TEST_TS_RE.test(testUrl)) {
      // Only *.test.ts files are test entries; infra files (testClient.ts,
      // testUtils.ts, ...) are compiled as-is when a test imports them.
      const isTestEntry = /\.test\.ts$/.test(testUrl)
      if (isTestEntry) {
        // The test file is the child's main module; derive its lane from the
        // path and set the lane env. Run preload HERE, in this load hook: it
        // fires before any of the test's dependencies are instantiated, so
        // global.__TEST__/env are in place before the coc-bundle: load hooks
        // below initialize src modules (getConditionValue-style test values
        // would otherwise pick the production branch). Spawned helper
        // processes (e.g. bin/coc-mcp.js) never load a test file, so they
        // stay untouched.
        const rel = path.relative(projectRoot, fileURLToPath(testUrl))
        const lane = laneForFile(rel)
        if (lane === 'vim') process.env.VIM_NODE_RPC = '1'
        else delete process.env.VIM_NODE_RPC
        if (lane !== 'unit') ensureBundle()
        require(preloadPath)
        if (lane !== 'unit' && !isRaw) {
          return {
            format: 'module',
            source: editorEntrySource(lane, rel),
            shortCircuit: true,
          }
        }
        return {
          format: 'module',
          source: compileTest(testUrl),
          shortCircuit: true,
        }
      }
      return {
        format: 'module',
        source: compileTest(testUrl),
        shortCircuit: true,
      }
    }
    if (url.startsWith('coc-pkg:')) {
      const pkgPath = url.slice('coc-pkg:'.length)
      const cjs = require(pkgPath)
      const lines = [
        "import { createRequire } from 'node:module'",
        `const require = createRequire(${JSON.stringify(pkgPath)})`,
        `const __cjs = require(${JSON.stringify(pkgPath)})`,
        'export default __cjs.default !== undefined ? __cjs.default : __cjs',
      ]
      for (const name of Object.keys(cjs)) {
        if (name === 'default' || name === '__esModule') continue
        lines.push(`export const ${name} = __cjs[${JSON.stringify(name)}]`)
      }
      return {
        format: 'module',
        source: lines.join('\n'),
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})
