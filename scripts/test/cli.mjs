'use strict'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {discoverTests} from './discover.mjs'
import {runUnit} from './run.mjs'
import {createLiveReporter} from './reporter.mjs'
import {cacheDir} from './paths.mjs'

function failureText(data) {
  const error = data.details?.error
  const stack = error?.cause?.stack || error?.stack
  const message = error?.cause?.message || error?.message
  return stack || message || String(error)
}

const {values, positionals} = parseArgs({
  options: {
    unit: {type: 'boolean', default: false},
    jobs: {type: 'string', short: 'j'},
    'test-name-pattern': {type: 'string', short: 't'},
    list: {type: 'boolean'},
    'keep-temp': {type: 'boolean'},
    'force-exit': {type: 'boolean'},
  },
  allowPositionals: true,
})

// No --nvim/--vim flags: lane is decided by path (discover.mjs) — the unit
// directory is unit, VIM_TESTS is vim, everything else is nvim. The default
// run executes all three lanes; --unit restricts to the unit lane.
const lanes = values.unit ? ['unit'] : ['unit', 'nvim', 'vim']
const testNamePattern = values['test-name-pattern']

// Unit tests get all CPU cores in phase 1; editor lanes are capped at 8
// (measured sweet spot) in phase 2. -j overrides both.
const unitJobs = Math.max(1, Number(values.jobs) || os.cpus().length)
const editorJobs = Math.max(1, Number(values.jobs) || Math.min(8, os.cpus().length - 1))
const LANE_TEST_TIMEOUT = {unit: 3000, nvim: 5000, vim: 5000}
const LANE_SHARD_TIMEOUT = {unit: 5 * 60 * 1000, nvim: 15 * 60 * 1000, vim: 15 * 60 * 1000}

async function loadTimings() {
  try {
    return JSON.parse(await fs.readFile(path.join(cacheDir, 'timings.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function existsSourceFile(key) {
  try {
    await fs.access(path.join(process.cwd(), key))
    return true
  } catch {
    return false
  }
}

async function persistTimings(timings, result) {
  const validOld = {}
  for (const [key, ms] of Object.entries(timings)) {
    if (/^src\/__tests__\/.*\.test\.ts$/.test(key) && await existsSourceFile(key)) validOld[key] = ms
  }
  const merged = {...validOld, ...result.timings}
  await fs.mkdir(cacheDir, {recursive: true})
  await fs.writeFile(path.join(cacheDir, 'timings.json'), JSON.stringify(merged, null, 2) + '\n')
  return merged
}

async function runLane(lane, {files, jobs, reporter}) {
  // Files are passed by their real source paths; bundle-hooks.mjs derives
  // each child's lane and injects preload/EditorSession per file.
  return await runUnit(files, {
    lane,
    concurrency: jobs,
    testNamePattern,
    keepTemp: values['keep-temp'],
    forceExit: values['force-exit'],
    testTimeout: LANE_TEST_TIMEOUT[lane],
    shardTimeoutMs: LANE_SHARD_TIMEOUT[lane],
    onProgress: (file, state) => {
      reporter.update(file, state)
    },
    onFailure: data => {
      process.stderr.write(`\nFAIL ${data.file ? `${data.file}: ` : ''}${data.name}\n${failureText(data)}\n`)
    },
  })
}

const startedAt = performance.now()
const discovered = await discoverTests(positionals)

if (values.list) {
  for (const lane of lanes) {
    for (const file of discovered[lane]) {
      if (file.runnable) console.log(file.file)
    }
  }
  process.exit(0)
}

let timings = await loadTimings()
let failed = 0
const laneResults = []

async function collect(lane, result, files) {
  laneResults.push({lane, durationMs: result.durationMs, result: result.stats, files})
  if (result.stats.failed > 0) failed += result.stats.failed
  timings = await persistTimings(timings, result)
  for (const message of result.stats.diagnostics) {
    console.error(`[test] ${message}`)
  }
  for (const failure of result.stats.failures) {
    console.error(`\nFAIL ${failure.name}`)
    console.error(failureText(failure))
  }
}

const runnableByLane = Object.fromEntries(lanes.map(lane => [lane, discovered[lane].filter(file => file.runnable)]))
const allFiles = lanes.flatMap(lane => runnableByLane[lane])
const reporter = createLiveReporter(allFiles.map(file => file.file))

// Phase 1 — unit tests run first in an isolation:none worker pool using all
// CPU cores, so they never contend with the heavier editor sessions.
// Longest-running files are assigned first so the pool drains evenly.
if (lanes.includes('unit') && runnableByLane.unit.length > 0) {
  const files = runnableByLane.unit
    .slice()
    .sort((a, b) => (timings[b.file] ?? 0) - (timings[a.file] ?? 0))
    .map(file => file.file)
  const result = await runLane('unit', {
    files,
    jobs: unitJobs,
    reporter,
  })
  await collect('unit', result, files.length)
}

// Phase 2 — nvim + vim share one rolling pool capped at editorJobs: node:test
// run() fills each freed slot with the next pending file immediately, so a
// finished test is replaced on the spot until everything is done.
// Historically slowest first.
const editorLanes = lanes.filter(lane => lane !== 'unit')
if (editorLanes.length > 0) {
  const editorFiles = editorLanes
    .flatMap(lane => runnableByLane[lane])
    .slice()
    .sort((a, b) => (timings[b.file] ?? 0) - (timings[a.file] ?? 0))
    .map(file => file.file)
  if (editorFiles.length > 0) {
    const result = await runLane(editorLanes[0], {
      files: editorFiles,
      jobs: editorJobs,
      reporter,
    })
    // Split the aggregate result back into per-lane summaries from the
    // per-file completion statuses.
    timings = await persistTimings(timings, result)
    for (const lane of editorLanes) {
      let passed = 0
      let laneFailed = 0
      for (const file of runnableByLane[lane]) {
        const counts = result.leafStats[file.file]
        if (counts) {
          passed += counts.passed
          laneFailed += counts.failed
        }
      }
      laneResults.push({
        lane,
        durationMs: result.durationMs,
        result: {passed, failed: laneFailed, skipped: 0},
        files: runnableByLane[lane].length,
      })
      failed += laneFailed
    }
    for (const message of result.stats.diagnostics) {
      console.error(`[test] ${message}`)
    }
    for (const failure of result.stats.failures) {
      console.error(`\nFAIL ${failure.name}`)
      console.error(failureText(failure))
    }
  }
}
reporter.finish()

for (const {lane, durationMs, result, files} of laneResults) {
  let line = `${files} files, ${result.passed} passed, ${result.failed} failed`
  if (result.skipped > 0) line += `, ${result.skipped} skipped`
  line += `, ${formatDuration(durationMs)}`
  console.log(`${lane} lane: ${line}`)
}
const total = Math.round(performance.now() - startedAt)
console.log(`total ${formatDuration(total)}`)
process.exitCode = failed > 0 ? 1 : 0

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}
