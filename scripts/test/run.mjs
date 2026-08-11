'use strict'

import {run} from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Worker} from 'node:worker_threads'
import {ISOLATED_UNIT_TESTS} from './discover.mjs'
import {projectRoot} from './paths.mjs'
import {writeBundleFiles} from './bundle.mjs'

function relPath(absPath) {
  const p = path.isAbsolute(absPath) ? absPath : path.resolve(absPath)
  const relRoot = path.relative(projectRoot, p)
  if (relRoot.startsWith('..')) return absPath
  // node:test's data.file can drop the .ts extension (sourcemapped source
  // path); restore it so timings keys match the repository layout.
  if (!relRoot.endsWith('.ts') && fs.existsSync(path.join(projectRoot, relRoot + '.ts'))) {
    return relRoot + '.ts'
  }
  return relRoot
}

/**
 * Maps node:test's file-level lifecycle events to reporter states. The
 * TestsStream uses test:dequeue/test:complete for child test files; the
 * test:start/test:pass events belong to suites and leaf tests instead.
 */
export function getFileProgress(event, files) {
  const data = event.data
  // File events use the absolute file path for both fields. Editor wrappers
  // deliberately name their outer suite after the relative file path, so a
  // files.has() check alone would report that suite as a second file run.
  if (typeof data?.name !== 'string' || data.name !== data.file) return undefined
  const file = relPath(data.name)
  if (!files.has(file)) return undefined
  if (event.type === 'test:dequeue') {
    return {file, state: {status: 'running', durationMs: 0}}
  }
  if (event.type === 'test:complete') {
    return {
      file,
      state: {
        status: data.details?.passed ? 'passed' : 'failed',
        durationMs: data.details?.duration_ms ?? 0,
      },
    }
  }
  return undefined
}

/**
 * Executes the given test files with node:test and consumes the structured
 * TestsStream directly (document section 12.2). Unit files use an
 * isolation:none worker pool; editor files run in their own child processes.
 * bundle-hooks.mjs derives each file's lane and injects preload/EditorSession.
 * On Node 24 leaf tests carry details.type === 'test' while suites carry
 * details.type === 'suite'.
 */
export async function runUnit(
  files,
  {
    lane = 'unit',
    concurrency = 6,
    testNamePattern,
    forceExit = false,
    shardTimeoutMs = 5 * 60 * 1000,
    testTimeout = 3000,
    onProgress,
    onFailure,
  } = {}
) {
  // COC_TEST_ROOT is now the repository root: src/util/constants uses it as
  // pluginRoot so bin/data resolve from the source tree. All compilation is
  // in memory (only the editor-runtime bundle is written to .cache).
  process.env.COC_TEST_ROOT = projectRoot
  // The editor-runtime bundle is built exactly once by the parent and
  // written to `.cache/coc-test/bundle.js`; children just require() it
  // (bundle-hooks.mjs / preload.cjs) and never rebuild. The package list
  // lets hooks route test imports of bundled packages to `pkg:<spec>`.
  await ensureBundleFiles()
  if (lane === 'unit') {
    return await runUnitThreads(files, {
      concurrency,
      testNamePattern,
      forceExit,
      shardTimeoutMs,
      testTimeout,
      onProgress,
      onFailure,
    })
  }
  const abort = new AbortController()
  const timeoutTimer = setTimeout(() => abort.abort(), shardTimeoutMs)
  timeoutTimer.unref?.()
  const stream = run({
    concurrency,
    execArgv: ['--enable-source-maps', `--import=${path.join(projectRoot, 'scripts', 'test', 'bundle-hooks.mjs')}`],
    files: files.map(f => (path.isAbsolute(f) ? f : path.join(projectRoot, f))),
    concurrency,
    timeout: testTimeout,
    forceExit,
    testNamePatterns: testNamePattern ? [new RegExp(testNamePattern)] : undefined,
    signal: abort.signal,
    env: Object.assign(process.env, {COC_TEST_LANE: lane})
  })

  const stats = {passed: 0, failed: 0, skipped: 0, todo: 0, failures: [], diagnostics: []}
  const requestedFiles = new Set(files.map(relPath))
  const fileStates = new Map()
  let suiteFailures = 0
  const captured = []
  let timedOut = false
  const leafDurations = new Map()
  const completedDurations = new Map()
  const fileLeafStats = new Map()
  const started = performance.now()
  for await (const event of stream) {
    const data = event.data
    const progress = getFileProgress(event, requestedFiles)
    if (progress) {
      if (progress.state.status !== 'running') {
        completedDurations.set(progress.file, progress.state.durationMs)
      }
      const current = fileStates.get(progress.file)
      if (current?.status !== progress.state.status || current.durationMs !== progress.state.durationMs) {
        fileStates.set(progress.file, progress.state)
        onProgress?.(progress.file, progress.state)
      }
    }
    const isLeaf = data.details?.type === 'test'
    switch (event.type) {
      case 'test:pass':
        if (isLeaf) {
          stats.passed++
          addDuration(data)
          bumpLeaf(data, 1)
        }
        break
      case 'test:fail':
        if (isLeaf) {
          stats.failed++
          stats.failures.push(data)
          addDuration(data)
          bumpLeaf(data, 0)
          onFailure?.(data)
        } else {
          suiteFailures++
        }
        break
      case 'test:skip':
        stats.skipped++
        break
      case 'test:todo':
        stats.todo++
        break
      case 'test:diagnostic':
        // Node's child runner emits its own summary as diagnostics; the
        // coordinator reports totals itself, so drop those standard lines.
        if (!/^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(data.message)) {
          stats.diagnostics.push(data.message)
        }
        break
      case 'test:stderr':
      case 'test:stdout':
        if (typeof data.message === 'string') {
          captured.push(data.message)
          // Forward test output live so console.error/console.log inside a
          // test (and probe/debug output) shows up while the run is still
          // going instead of being buffered until the shard finishes.
          if (event.type === 'test:stderr') process.stderr.write(data.message)
          else process.stdout.write(data.message)
        }
        break
    }
  }
  clearTimeout(timeoutTimer)
  if (abort.signal.aborted) timedOut = true

  // A failed module load surfaces only as a suite failure; without leaf
  // failures it would otherwise produce a false green run.
  if (stats.failed === 0 && suiteFailures > 0) {
    const detail = captured.join('').trim()
    stats.failures.push({
      name: 'suite failure',
      details: {
        error: {message: detail || 'a test suite failed to load or threw before any test ran'},
      },
    })
    stats.failed = suiteFailures
  }

  const timings = {}
  for (const file of requestedFiles) {
    const duration = completedDurations.get(file) ?? leafDurations.get(file)
    if (duration !== undefined) timings[file] = Math.round(duration)
  }
  const leafStats = {}
  for (const [file, counts] of fileLeafStats) {
    leafStats[file] = counts
  }
  return {stats, timings, leafStats, timedOut, durationMs: Math.round(performance.now() - started)}

  function addDuration(data) {
    if (data.file && typeof data.details?.duration_ms === 'number') {
      const file = relPath(data.file)
      const current = leafDurations.get(file) || 0
      leafDurations.set(file, current + data.details.duration_ms)
    }
  }

  function bumpLeaf(data, passed) {
    if (!data.file) return
    const key = relPath(data.file)
    const counts = fileLeafStats.get(key) || {passed: 0, failed: 0}
    if (passed) counts.passed++
    else counts.failed++
    fileLeafStats.set(key, counts)
  }
}

async function runUnitThreads(
  files,
  {
    concurrency,
    testNamePattern,
    forceExit,
    shardTimeoutMs,
    testTimeout,
    onProgress,
    onFailure,
  }
) {
  const started = performance.now()
  const maxWorkers = Math.max(1, Math.min(
    files.length,
    Number.isInteger(concurrency) ? concurrency : os.availableParallelism()
  ))
  const isolated = new Set(ISOLATED_UNIT_TESTS)
  const isolatedBatches = files.filter(file => isolated.has(file)).map(file => [file])
  const sharedFiles = files.filter(file => !isolated.has(file))
  const reserved = Math.min(isolatedBatches.length, Math.max(0, maxWorkers - 1))
  const sharedWorkerCount = Math.min(sharedFiles.length, Math.max(1, maxWorkers - reserved))
  const sharedBatches = Array.from({length: sharedWorkerCount}, () => [])
  for (let i = 0; i < sharedFiles.length; i++) {
    sharedBatches[i % sharedWorkerCount].push(sharedFiles[i])
  }
  const batches = [...isolatedBatches, ...sharedBatches.filter(batch => batch.length > 0)]
  const results = new Array(batches.length)
  let next = 0
  const runners = Array.from({length: Math.min(maxWorkers, batches.length)}, async () => {
    while (next < batches.length) {
      const index = next++
      results[index] = await runUnitWorker(batches[index], index, {
        testNamePattern,
        forceExit,
        shardTimeoutMs,
        testTimeout,
        onProgress,
        onFailure,
      })
    }
  })
  await Promise.all(runners)

  const stats = {passed: 0, failed: 0, skipped: 0, todo: 0, failures: [], diagnostics: []}
  const timings = {}
  const leafStats = {}
  let timedOut = false
  for (const result of results) {
    stats.passed += result.stats.passed
    stats.failed += result.stats.failed
    stats.skipped += result.stats.skipped
    stats.todo += result.stats.todo
    stats.failures.push(...result.stats.failures)
    stats.diagnostics.push(...result.stats.diagnostics)
    Object.assign(timings, result.timings)
    Object.assign(leafStats, result.leafStats)
    timedOut ||= result.timedOut
  }
  return {
    stats,
    timings,
    leafStats,
    timedOut,
    durationMs: Math.round(performance.now() - started),
  }
}

function runUnitWorker(
  files,
  id,
  {
    testNamePattern,
    forceExit,
    shardTimeoutMs,
    testTimeout,
    onProgress,
    onFailure,
  }
) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./unit-worker.mjs', import.meta.url), {
      workerData: {files, testNamePattern, shardTimeoutMs, testTimeout},
      env: {...process.env, COC_TEST_LANE: 'unit'},
    })
    let result
    worker.on('message', message => {
      switch (message.type) {
        case 'progress':
          onProgress?.(message.file, message.state)
          break
        case 'failure':
          onFailure?.(message.data)
          break
        case 'result':
          result = message.result
          if (forceExit) void worker.terminate()
          break
        case 'error':
          reject(Object.assign(new Error(message.error.message), {stack: message.error.stack}))
          break
      }
    })
    worker.on('error', reject)
    worker.on('exit', code => {
      if (result) resolve(result)
      else reject(new Error(`unit worker ${id} exited with code ${code}`))
    })
  })
}

let bundleFilesPromise

/** Builds + writes bundle.js/bundle.js.map once per runner process. */
function ensureBundleFiles() {
  if (!bundleFilesPromise) bundleFilesPromise = writeBundleFiles()
  return bundleFilesPromise
}
