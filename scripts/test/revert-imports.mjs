// @ts-check
// Reverts the editor test files to their ORIGINAL src imports now that
// bundle-hooks.mjs routes relative src imports to the editor-runtime bundle.
// Removes the `const X = bundle[...]` block and `import type` lines that
// duplicate a restored value import. Run with explicit file paths.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()

function localNames(importLine) {
  const m = /^import\s+(?:type\s+)?(.+?)\s+from\s+/.exec(importLine)
  if (!m) return []
  const spec = m[1]
  if (spec.startsWith('* as ')) return [spec.slice(5)]
  const names = []
  for (let part of spec.split(',')) {
    part = part.trim()
    if (!part) continue
    if (part.startsWith('{')) {
      for (let item of part.slice(1, -1).split(',')) {
        item = item.trim()
        if (!item) continue
        const as = item.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/)
        names.push(as ? as[1] : item.match(/[A-Za-z_$][\w$]*/)[0])
      }
    } else {
      const as = part.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/)
      names.push(as ? as[1] : part.match(/[A-Za-z_$][\w$]*/)[0])
    }
  }
  return names
}

function isTestLocalSpecifier(spec, fileDir) {
  if (spec === '../helper' || spec === './parser' || spec === '../editorSuite' ||
      spec === '../editorSession' || spec === '../sessionRegistry') {
    return true
  }
  const resolved = path.resolve(fileDir, spec)
  const rel = path.relative(projectRoot, resolved)
  return rel.startsWith('src' + path.sep + '__tests__')
}

function originalSrcImports(original, fileDir) {
  const out = []
  for (const line of original.split('\n')) {
    const m = /^import\s+(?:type\s+)?(?:[\w*{},\s]+?)\s+from\s+['"]([^'"]+)['"]/.exec(line)
    if (!m) continue
    const spec = m[1]
    if (!spec.startsWith('.')) continue
    if (isTestLocalSpecifier(spec, fileDir)) continue
    out.push(line)
  }
  return out
}

function revertFile(file) {
  const abs = path.resolve(file)
  const fileDir = path.dirname(abs)
  const original = execFileSync('git', ['show', `HEAD:${file}`], { cwd: projectRoot, encoding: 'utf8' })
  let current = fs.readFileSync(abs, 'utf8')

  const restored = originalSrcImports(original, fileDir)
  const restoredNames = new Set(restored.flatMap(localNames))

  // Remove the bundle const block.
  const lines = current.split('\n')
  const out = []
  let removedTypeLines = []
  let insertAt = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isBundleLine = /^\/\/ eslint-disable-next-line @typescript-eslint\/no-var-requires/.test(line) ||
      /^const\s+bundle\s*=\s*require\(/.test(line) ||
      (/^const\s+[A-Za-z_$][\w$]*\s*=/.test(line) && line.includes('bundle[')) ||
      (/^const\s+\{[^}]*\}\s*=/.test(line) && line.includes('bundle['))
    if (isBundleLine) continue
    if (/^import\s+type\s+/.test(line)) {
      const names = localNames(line)
      if (names.some(n => restoredNames.has(n))) {
        removedTypeLines.push(line)
        continue
      }
    }
    out.push(line)
  }
  // Insert the restored imports at the first import statement position so
  // they precede classes/hooks but stay after the file header comments.
  for (let i = 0; i < out.length; i++) {
    if (/^import\s/.test(out[i])) {
      insertAt = i
      break
    }
  }
  if (insertAt === -1) insertAt = 0
  const existing = new Set(lines.filter(l => /^import\s/.test(l)))
  const toInsert = restored.filter(l => !existing.has(l))
  out.splice(insertAt, 0, ...toInsert)
  const next = out.join('\n')
  fs.writeFileSync(abs, next)
  return { restored: toInsert.length, removedType: removedTypeLines.length }
}

for (const file of process.argv.slice(2)) {
  const { restored, removedType } = revertFile(file)
  console.log(`OK ${file}: restored ${restored} imports, removed ${removedType} type imports`)
}
