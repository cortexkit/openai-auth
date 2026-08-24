#!/usr/bin/env node
/**
 * Find tests that only pass when their siblings run first.
 *
 * A test that needs a sibling to seed its state cannot gate the behaviour it
 * names: it stays green while covering nothing, and it turns red for unrelated
 * reasons when someone iterates on it with `-t`. Both failures are silent from
 * the suite summary, which is why this has to be checked rather than noticed.
 *
 *   node scripts/find-order-dependent-tests.mjs packages/opencode/src/tests/integration.test.ts
 *
 * Runs each test alone and reports the ones that fail, having passed as part of
 * the whole file.
 */
import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (!file) {
  console.error('usage: find-order-dependent-tests.mjs <test-file>')
  process.exit(2)
}

// bun writes its run summary to stderr, so both streams have to be read; a
// stdout-only check reports every test as failing.
function run(args) {
  const result = spawnSync('bun', args, { encoding: 'utf8' })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

// Only passed tests are candidates: skipped and todo tests did not establish
// the whole-file baseline. A literal ` > ` in a test name is ambiguous here.
function passedNames(output) {
  return [
    ...output.matchAll(
      /^\(pass\)\s+(.+?)(?:\s+\[(?:\d+(?:\.\d+)?|\.\d+)(?:ns|µs|μs|ms|s)\])?$/gm,
    ),
  ].map((m) => m[1].replaceAll(' > ', ' '))
}

const whole = run(['test', file])
const wholeMatch = whole.match(/(\d+)\s+pass[\s\S]*?(\d+)\s+fail/)
if (wholeMatch?.[2] !== '0') {
  console.error('file does not pass as a whole; fix that before scanning')
  process.exit(1)
}
console.log(`whole file: ${wholeMatch[1]} pass, 0 fail`)

const names = passedNames(whole)
const wholeCount = Number(wholeMatch[1])

// bun treats -t as a regex, but test names are literal reporter output.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const failed = []
const unscannable = []
for (const name of names) {
  const out = run(['test', file, '-t', `^${escapeRegExp(name)}$`])
  const m = out.match(/(\d+)\s+pass[\s\S]*?(\d+)\s+fail/)
  // No match leaves this test's isolation unproven, not order-dependent.
  if (!m) {
    unscannable.push(name)
    continue
  }
  if (m[2] !== '0') failed.push(name)
}

console.log(`scanned ${names.length} tests individually`)
if (names.length !== wholeCount) {
  unscannable.push(
    `reporter parse mismatch: extracted ${names.length}, Bun reported ${wholeCount}`,
  )
}
if (failed.length === 0 && unscannable.length === 0) {
  console.log('all pass in isolation')
}
if (failed.length > 0) {
  console.log(`ORDER-DEPENDENT (${failed.length}):`)
  for (const name of failed) console.log(`  ${name}`)
  process.exitCode = 1
}
if (unscannable.length > 0) {
  console.log(`UNSCANNABLE (${unscannable.length}):`)
  for (const name of unscannable) console.log(`  ${name}`)
  process.exitCode = 1
}
