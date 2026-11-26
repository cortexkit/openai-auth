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
import { constants } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packages = fileURLToPath(new URL('../packages/', import.meta.url))
const file = process.argv[2] && resolve(process.argv[2])
const fromPackages = file ? relative(packages, file) : ''
const [packageName, ...testPath] = fromPackages.split(sep)
if (
  !packageName ||
  packageName === '..' ||
  isAbsolute(fromPackages) ||
  testPath.length === 0
) {
  console.error(
    'usage: find-order-dependent-tests.mjs packages/<name>/<test-file>',
  )
  process.exit(2)
}
const cwd = join(packages, packageName)

// bun writes its run summary to stderr, so both streams have to be read; a
// stdout-only check reports every test as failing.
function run(args) {
  const result = spawnSync(
    'bun',
    ['test', `.${sep}${testPath.join(sep)}`, ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  )
  if (result.error) {
    console.error(`Could not run Bun tests: ${result.error.message}`)
    process.exit(1)
  }
  return {
    status: result.signal
      ? 128 + constants.signals[result.signal]
      : result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
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

function counts(output) {
  return output.match(/^\s*(\d+) pass[\t ]*$[\s\S]*?^\s*(\d+) fail[\t ]*$/m)
}

const whole = run([])
const wholeMatch = counts(whole.output)
if (whole.status !== 0 || wholeMatch?.[2] !== '0' || wholeMatch[1] === '0') {
  console.error('file does not pass as a whole; fix that before scanning')
  console.error(whole.output)
  process.exit(whole.status || 1)
}
console.log(`whole file: ${wholeMatch[1]} pass, 0 fail`)

const names = passedNames(whole.output)
const wholeCount = Number(wholeMatch[1])

// bun treats -t as a regex, but test names are literal reporter output.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const failed = []
const unscannable = []
for (const name of names) {
  const { status, output } = run(['-t', `^${escapeRegExp(name)}$`])
  const m = counts(output)
  if (status !== 0) process.exitCode ||= status
  if (m?.[1] === '0' && m[2] === '1') failed.push(name)
  else if (status !== 0 || m?.[1] !== '1' || m[2] !== '0')
    unscannable.push(name)
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
  process.exitCode ||= 1
}
if (unscannable.length > 0) {
  console.log(`UNSCANNABLE (${unscannable.length}):`)
  for (const name of unscannable) console.log(`  ${name}`)
  process.exitCode ||= 1
}
