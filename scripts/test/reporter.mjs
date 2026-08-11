'use strict'

const ANSI = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
}

const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Live per-file progress. A line appears when a test file starts running,
 * with a spinner that rotates every 100ms in place; the line updates to
 * ✓/✗ + duration when the file finishes. When stdout is piped (CI), state
 * transitions are printed as plain sequential lines.
 */
export function createLiveReporter(_files, { stdout = process.stdout } = {}) {
  const isTTY = Boolean(stdout.isTTY)
  const state = new Map()
  const order = []
  let frame = 0
  let timer = null
  let drawn = 0

  function format(file) {
    const s = state.get(file)
    if (s.status === 'running') return `  ${SPINNERS[frame]} ${file}`
    const mark = s.status === 'passed' ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`
    const duration = s.durationMs > 0 ? `  ${ANSI.yellow}${Math.round(s.durationMs)}ms${ANSI.reset}` : ''
    return `  ${mark} ${file}${duration}`
  }

  function render() {
    if (order.length === 0) return
    if (drawn > 0) stdout.write(`\x1b[${drawn}A`)
    for (const file of order) {
      stdout.write(`\x1b[2K${format(file)}\n`)
    }
    drawn = order.length
    stdout.write('\x1b[J')
  }

  function hasRunning() {
    for (const s of state.values()) {
      if (s.status === 'running') return true
    }
    return false
  }

  if (isTTY) {
    timer = setInterval(() => {
      if (!hasRunning()) return
      frame = (frame + 1) % SPINNERS.length
      render()
    }, 100)
    timer.unref?.()
  }

  return {
    update(file, next) {
      const current = state.get(file)
      if (current && current.status === next.status && current.durationMs === next.durationMs) return
      state.set(file, next)
      if (!current) order.push(file)
      if (isTTY) {
        render()
      } else {
        const mark = next.status === 'passed' ? '✓' : next.status === 'failed' ? '✗' : '▶'
        const duration = next.durationMs > 0 ? `  ${Math.round(next.durationMs)}ms` : ''
        stdout.write(`${mark} ${file}${duration}\n`)
      }
    },
    finish() {
      if (timer) clearInterval(timer)
      if (isTTY && order.length > 0) {
        render()
        stdout.write('\n')
      }
    },
  }
}
