#!/usr/bin/env bun

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const DEFAULT_DB = join(homedir(), '.local/share/opencode/opencode.db')
const DEFAULT_DUMP_DIR = join(tmpdir(), 'opencode-openai-auth-dumps')

const args = parseArgs(process.argv.slice(2))
const sessionID = args.session ?? args.s
if (!sessionID) {
  usage(1)
}

const dbPath = resolvePath(args.db ?? DEFAULT_DB)
const dumpDir = resolvePath(args['dump-dir'] ?? args.dumps ?? DEFAULT_DUMP_DIR)
const threshold = Number(args.threshold ?? 0.05)
const minUncached = Number(args['min-uncached'] ?? 1024)
const limit = args.limit === undefined ? undefined : Number(args.limit)
const wireContext = Number(args['wire-context'] ?? 0)

if (!existsSync(dbPath)) fail(`OpenCode DB not found: ${dbPath}`)
if (!existsSync(dumpDir)) fail(`dump dir not found: ${dumpDir}`)

const dumps = loadDumps(dumpDir, sessionID)
const rows = loadUsageRows(dbPath, sessionID)
const toolParts = loadToolParts(dbPath, sessionID)
const callIDSummary = analyzeWireToolCallIDs(dumps)
const paired = pairUsageToDumps(
  rows,
  dumps.filter((dump) => dump.phase === 'main'),
)
const cliffs = findCliffs(paired, { threshold, minUncached })

printSummary({
  sessionID,
  dbPath,
  dumpDir,
  dumps,
  rows,
  toolParts,
  callIDSummary,
  paired,
  cliffs,
  limit,
})

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') usage(0)
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      index++
    }
  }
  return out
}

function usage(code) {
  console.error(`Usage: bun scripts/analyze-cache-cliffs.mjs --session <session-id> [options]

Options:
  --dump-dir <path>       Dump directory (default: ${DEFAULT_DUMP_DIR})
  --db <path>             OpenCode sqlite DB (default: ${DEFAULT_DB})
  --threshold <ratio>     Drop threshold from previous hit ratio (default: 0.05)
  --min-uncached <tokens> Minimum uncached input tokens to flag (default: 1024)
  --limit <n>             Limit printed cliffs
  --no-timeline           Print cliffs only
  --details               Print full request-diff JSON for each cliff
  --wire-context <bytes>  Print raw body context around first wire byte diff
`)
  process.exit(code)
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function resolvePath(path) {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

function loadDumps(root, sessionID) {
  const files = readdirSync(root)
    .filter((name) => name.includes(sessionID) && name.endsWith('.meta.json'))
    .sort()
  return files.map((name) => {
    const metaPath = join(root, name)
    const meta = readJson(metaPath)
    const bodyPath =
      meta.files?.body ?? metaPath.replace(/\.meta\.json$/, '.body.json')
    const body = readJson(bodyPath)
    const input = Array.isArray(body.input) ? body.input : []
    const inputHashes = input.map((item) => hashStable(item))
    return {
      id: meta.id,
      createdAt: meta.createdAt,
      ms: Date.parse(meta.createdAt),
      metaPath,
      bodyPath,
      requestPath: meta.files?.request,
      // `channel` since the shared dumper; `transport` in older dumps.
      transport: meta.channel ?? meta.transport,
      phase: meta.phase,
      bodyBytes: meta.bodyBytes,
      bodyHash: meta.bodyHash,
      diff: meta.diff,
      summary: meta.body ?? {},
      body,
      input,
      inputHashes,
    }
  })
}

function loadUsageRows(dbPath, sessionID) {
  const db = new Database(dbPath, { readonly: true })
  const query = db.query(
    `select id, message_id as messageID, time_created as timeCreated, data
       from part
      where session_id = ?
      order by time_created, id`,
  )
  const rows = []
  for (const row of query.all(sessionID)) {
    const data = safeJson(row.data)
    if (data?.type !== 'step-finish' || !data.tokens) continue
    const tokens = data.tokens
    const input = Number(tokens.input ?? 0)
    const cacheRead = Number(tokens.cache?.read ?? 0)
    rows.push({
      id: row.id,
      messageID: row.messageID,
      timeCreated: Number(row.timeCreated),
      iso: new Date(Number(row.timeCreated)).toISOString(),
      reason: data.reason,
      tokens: {
        total: Number(tokens.total ?? input + cacheRead),
        prompt: input + cacheRead,
        input,
        output: Number(tokens.output ?? 0),
        reasoning: Number(tokens.reasoning ?? 0),
        cacheRead,
        cacheWrite: Number(tokens.cache?.write ?? 0),
      },
      cost: data.cost,
    })
  }
  db.close()
  return rows
}

function loadToolParts(dbPath, sessionID) {
  const db = new Database(dbPath, { readonly: true })
  const query = db.query(
    `select id, message_id as messageID, time_created as timeCreated, data
       from part
      where session_id = ?
      order by time_created, id`,
  )
  const parts = new Map()
  for (const row of query.all(sessionID)) {
    const data = safeJson(row.data)
    if (data?.type !== 'tool' || typeof data.callID !== 'string') continue
    const output = data.state?.output
    if (typeof output !== 'string') continue
    parts.set(data.callID, {
      id: row.id,
      messageID: row.messageID,
      timeCreated: Number(row.timeCreated),
      output,
      outputBytes: output.length,
      outputHash: hashText(output),
      status: data.state?.status,
      tool: data.tool,
    })
  }
  db.close()
  return parts
}

function analyzeWireToolCallIDs(dumps) {
  const byCallID = new Map()
  const byStrippedOutputHash = new Map()
  let itemCount = 0
  for (const dump of dumps) {
    if (dump.phase !== 'main') continue
    for (const [index, item] of dump.input.entries()) {
      if (item?.type !== 'function_call_output') continue
      if (typeof item.call_id !== 'string') continue
      if (typeof item.output !== 'string') continue
      itemCount++
      const tagPrefix = item.output.match(/^§\d+§ ?/)?.[0]
      const strippedOutput = tagPrefix
        ? item.output.slice(tagPrefix.length)
        : item.output
      const record = {
        dump: basename(dump.metaPath).replace(/\.meta\.json$/, ''),
        index,
        callID: item.call_id,
        outputHash: hashText(item.output),
        strippedOutputHash: hashText(strippedOutput),
        strippedOutputBytes: strippedOutput.length,
      }
      pushMap(byCallID, item.call_id, record)
      pushMap(byStrippedOutputHash, record.strippedOutputHash, record)
    }
  }
  const repeatedCallIDs = [...byCallID.values()].filter(
    (records) => records.length > 1,
  )
  const mutatedCallIDs = repeatedCallIDs.filter(
    (records) => new Set(records.map((record) => record.outputHash)).size > 1,
  )
  const sameOutputDifferentCallIDs = [...byStrippedOutputHash.values()].filter(
    (records) =>
      records[0]?.strippedOutputBytes > 0 &&
      new Set(records.map((record) => record.callID)).size > 1,
  )
  return {
    itemCount,
    uniqueCallIDs: byCallID.size,
    repeatedCallIDs: repeatedCallIDs.length,
    mutatedCallIDs: mutatedCallIDs.length,
    sameOutputDifferentCallIDs: sameOutputDifferentCallIDs.length,
  }
}

function pushMap(map, key, value) {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

function pairUsageToDumps(rows, mainDumps) {
  let dumpIndex = 0
  const paired = []
  for (const row of rows) {
    let candidate
    while (
      dumpIndex < mainDumps.length &&
      mainDumps[dumpIndex].ms <= row.timeCreated + 2_000
    ) {
      candidate = mainDumps[dumpIndex]
      dumpIndex++
    }
    paired.push({ ...row, dump: candidate })
  }
  return paired
}

function findCliffs(paired, { threshold, minUncached }) {
  const cliffs = []
  for (let index = 0; index < paired.length; index++) {
    const current = paired[index]
    const previous = paired[index - 1]
    const prompt = current.tokens.prompt
    const hitRatio = prompt > 0 ? current.tokens.cacheRead / prompt : 0
    current.hitRatio = hitRatio
    if (!previous) continue
    const previousPrompt = previous.tokens.prompt
    const previousHitRatio =
      previousPrompt > 0 ? previous.tokens.cacheRead / previousPrompt : 0
    previous.hitRatio = previousHitRatio
    const hitDrop = previousHitRatio - hitRatio
    const readDrop = previous.tokens.cacheRead - current.tokens.cacheRead
    const promptGrowth = current.tokens.prompt - previous.tokens.prompt
    const uncachedGrowth = current.tokens.input - previous.tokens.input
    if (
      hitDrop >= threshold ||
      (current.tokens.input >= minUncached && readDrop > 0) ||
      uncachedGrowth >= minUncached * 4
    ) {
      const previousComparable = findPreviousComparable(paired, index)
      cliffs.push({
        index,
        current,
        previous,
        previousComparable,
        hitDrop,
        readDrop,
        promptGrowth,
        uncachedGrowth,
        comparison: compareDumps(
          previousComparable?.dump,
          current.dump,
          toolParts,
        ),
        immediateComparison: compareDumps(
          previous.dump,
          current.dump,
          toolParts,
        ),
      })
    }
  }
  return cliffs
}

function findPreviousComparable(paired, index) {
  const currentDump = paired[index].dump
  if (!currentDump) return paired[index - 1]
  const currentInputCount =
    currentDump.summary.inputCount ?? currentDump.input.length
  const currentIsFullReplay = currentInputCount > 1
  for (let i = index - 1; i >= 0; i--) {
    const dump = paired[i].dump
    if (!dump) continue
    const inputCount = dump.summary.inputCount ?? dump.input.length
    if (currentIsFullReplay === inputCount > 1) return paired[i]
  }
  return paired[index - 1]
}

function compareDumps(previous, current, toolParts) {
  if (!previous || !current) return undefined
  const commonPrefix = commonPrefixLength(
    previous.inputHashes,
    current.inputHashes,
  )
  return {
    previousDump: basename(previous.metaPath).replace(/\.meta\.json$/, ''),
    currentDump: basename(current.metaPath).replace(/\.meta\.json$/, ''),
    previousBodyPath: previous.bodyPath,
    currentBodyPath: current.bodyPath,
    previousInputCount: previous.summary.inputCount ?? previous.input.length,
    currentInputCount: current.summary.inputCount ?? current.input.length,
    previousInputBytes: previous.summary.inputBytes,
    currentInputBytes: current.summary.inputBytes,
    previousBodyBytes: previous.bodyBytes,
    currentBodyBytes: current.bodyBytes,
    rawFirstDiffByte: current.diff?.firstByte,
    rawChangedPreviousBytes: current.diff?.changedPreviousBytes,
    rawChangedCurrentBytes: current.diff?.changedCurrentBytes,
    previousPromptCacheKey: previous.summary.promptCacheKey,
    currentPromptCacheKey: current.summary.promptCacheKey,
    promptCacheKeyChanged:
      previous.summary.promptCacheKey !== current.summary.promptCacheKey,
    toolsHashChanged: previous.summary.toolsHash !== current.summary.toolsHash,
    previousPreviousResponseID: previous.summary.previousResponseID,
    currentPreviousResponseID: current.summary.previousResponseID,
    commonPrefixItems: commonPrefix,
    previousAllToolOutputs: previous.input.every(
      (item) => item?.type === 'function_call_output',
    ),
    currentAllToolOutputs: current.input.every(
      (item) => item?.type === 'function_call_output',
    ),
    firstDiffPrevious: summarizeInput(previous.input[commonPrefix], toolParts),
    firstDiffCurrent: summarizeInput(current.input[commonPrefix], toolParts),
  }
}

function commonPrefixLength(a, b) {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return index
  }
  return length
}

function summarizeInput(item, toolParts) {
  if (item === undefined) return undefined
  if (!item || typeof item !== 'object') return { value: item }
  const record = item
  const summary = {
    type: record.type,
    role: record.role,
    name: record.name,
    call_id: record.call_id,
    id: record.id,
  }
  if (typeof record.content === 'string')
    summary.contentPreview = preview(record.content)
  if (Array.isArray(record.content)) {
    summary.contentTypes = record.content.map((part) => part?.type).slice(0, 8)
    const text = record.content
      .map((part) => part?.text ?? part?.input_text ?? part?.output_text)
      .filter(Boolean)
      .join('\n')
    if (text) summary.textPreview = preview(text)
  }
  if (typeof record.output === 'string') {
    summary.outputBytes = record.output.length
    summary.outputHash = hashText(record.output)
    summary.outputPreview = preview(record.output)
    if (
      record.type === 'function_call_output' &&
      typeof record.call_id === 'string'
    ) {
      const dbTool = toolParts?.get(record.call_id)
      const tagPrefix = record.output.match(/^§\d+§ ?/)?.[0]
      const tagStrippedOutput = tagPrefix
        ? record.output.slice(tagPrefix.length)
        : record.output
      summary.dbOutputBytes = dbTool?.outputBytes
      summary.dbOutputHash = dbTool?.outputHash
      summary.dbOutputMatch = dbTool ? dbTool.output === record.output : false
      summary.dbOutputMatchAfterTagStrip = dbTool
        ? dbTool.output === tagStrippedOutput
        : false
      summary.tagPrefix = tagPrefix?.trim()
      summary.dbTool = dbTool?.tool
    }
  }
  if (typeof record.arguments === 'string') {
    summary.argumentsBytes = record.arguments.length
    summary.argumentsPreview = preview(record.arguments)
  }
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  )
}

function preview(value) {
  return value.replace(/\s+/g, ' ').slice(0, 180)
}

function printSummary({
  sessionID,
  dbPath,
  dumpDir,
  dumps,
  rows,
  toolParts,
  callIDSummary,
  paired,
  cliffs,
  limit,
}) {
  console.log(`# Cache cliff analysis`)
  console.log(`session: ${sessionID}`)
  console.log(`db: ${dbPath}`)
  console.log(`dumpDir: ${dumpDir}`)
  console.log(
    `dumps: ${dumps.length} (${dumps.filter((dump) => dump.phase === 'main').length} main)`,
  )
  console.log(`usageRows: ${rows.length}`)
  console.log(`toolParts: ${toolParts.size}`)
  console.log(
    `wireToolOutputs: ${callIDSummary.itemCount} (` +
      `uniqueCallIDs=${callIDSummary.uniqueCallIDs}, ` +
      `repeatedCallIDs=${callIDSummary.repeatedCallIDs}, ` +
      `mutatedCallIDs=${callIDSummary.mutatedCallIDs}, ` +
      `sameOutputDifferentCallIDs=${callIDSummary.sameOutputDifferentCallIDs})`,
  )
  console.log(`cliffs: ${cliffs.length}`)
  console.log('')
  if (!args['no-timeline']) {
    printTimeline(paired)
    console.log('')
  }
  printCliffs(cliffs, limit, Boolean(args.details), wireContext)
}

function printTimeline(paired) {
  console.log(`## Timeline`)
  console.log(
    [
      'idx',
      'time',
      'hit',
      'prompt',
      'cached',
      'uncached',
      'reason',
      'inputCount',
      'bodyKB',
      'dump',
    ].join('\t'),
  )
  paired.forEach((row, index) => {
    const dump = row.dump
    console.log(
      [
        index,
        row.iso.slice(11, 19),
        pct(
          row.hitRatio ?? row.tokens.cacheRead / Math.max(row.tokens.prompt, 1),
        ),
        row.tokens.prompt,
        row.tokens.cacheRead,
        row.tokens.input,
        row.reason ?? '',
        dump?.summary.inputCount ?? '',
        dump ? Math.round(dump.bodyBytes / 1024) : '',
        dump ? basename(dump.metaPath).replace(/\.meta\.json$/, '') : '',
      ].join('\t'),
    )
  })
}

function printCliffs(cliffs, limit, details, wireContext) {
  console.log(`## Cliffs`)
  const printed = limit === undefined ? cliffs : cliffs.slice(0, limit)
  for (const cliff of printed) {
    const row = cliff.current
    const previous = cliff.previous
    console.log('')
    console.log(`### #${cliff.index} ${row.iso}`)
    console.log(
      `hit ${pct(previous.hitRatio)} -> ${pct(row.hitRatio)} (` +
        `cached ${previous.tokens.cacheRead} -> ${row.tokens.cacheRead}, ` +
        `uncached ${previous.tokens.input} -> ${row.tokens.input}, ` +
        `prompt ${previous.tokens.prompt} -> ${row.tokens.prompt})`,
    )
    console.log(`reason: ${classifyCliff(cliff)}`)
    const immediate = cliff.immediateComparison
    if (immediate && !details) {
      console.log(
        `request: ${immediate.previousDump} -> ${immediate.currentDump} ` +
          `(input ${immediate.previousInputCount}->${immediate.currentInputCount}, ` +
          `bodyKB ${Math.round(immediate.previousBodyBytes / 1024)}->${Math.round(immediate.currentBodyBytes / 1024)}, ` +
          `commonPrefix=${immediate.commonPrefixItems})`,
      )
      console.log(
        `firstDiffPrev: ${describeInputSummary(immediate.firstDiffPrevious)}`,
      )
      console.log(
        `firstDiffCurr: ${describeInputSummary(immediate.firstDiffCurrent)}`,
      )
      if (wireContext > 0) printWireContext(immediate, wireContext)
    }
    if (immediate && details) {
      console.log('immediateDiff:', JSON.stringify(immediate, null, 2))
    }
    if (
      cliff.previousComparable &&
      cliff.previousComparable !== cliff.previous &&
      cliff.comparison &&
      details
    ) {
      console.log('comparableDiff:', JSON.stringify(cliff.comparison, null, 2))
    }
  }
}

function describeInputSummary(summary) {
  if (!summary) return 'none'
  const id = summary.call_id ?? summary.id ?? ''
  const bytes = summary.outputBytes ?? summary.argumentsBytes
  const byteText = bytes === undefined ? '' : ` bytes=${bytes}`
  const dbMatch =
    summary.dbOutputMatch === undefined
      ? ''
      : ` dbMatch=${summary.dbOutputMatch}`
  const tagMatch =
    summary.dbOutputMatchAfterTagStrip === undefined
      ? ''
      : ` tagStrippedMatch=${summary.dbOutputMatchAfterTagStrip}`
  const tag = summary.tagPrefix ? ` tag=${summary.tagPrefix}` : ''
  const preview =
    summary.outputPreview ??
    summary.argumentsPreview ??
    summary.textPreview ??
    summary.contentPreview ??
    ''
  return `${summary.type ?? summary.role ?? 'item'}${id ? ` ${id}` : ''}${byteText}${dbMatch}${tagMatch}${tag}${preview ? ` ${JSON.stringify(preview)}` : ''}`
}

function printWireContext(comparison, contextBytes) {
  const firstDiff = comparison.rawFirstDiffByte
  if (typeof firstDiff !== 'number') return
  const previous = readFileSync(comparison.previousBodyPath, 'utf8')
  const current = readFileSync(comparison.currentBodyPath, 'utf8')
  const start = Math.max(0, firstDiff - contextBytes)
  const end = firstDiff + contextBytes
  console.log(`wireFirstDiffByte: ${firstDiff}`)
  console.log(`wirePrev: ${JSON.stringify(previous.slice(start, end))}`)
  console.log(`wireCurr: ${JSON.stringify(current.slice(start, end))}`)
}

function classifyCliff(cliff) {
  const cmp = cliff.comparison ?? cliff.immediateComparison
  const immediate = cliff.immediateComparison
  if (!cmp) return 'no matched request dump'
  if (cmp.promptCacheKeyChanged) return 'prompt_cache_key changed'
  if (cmp.toolsHashChanged) return 'tools changed'
  if (
    immediate?.previousAllToolOutputs &&
    immediate.currentAllToolOutputs &&
    immediate.firstDiffCurrent?.type === 'function_call_output'
  ) {
    const bytes = immediate.firstDiffCurrent.outputBytes ?? 0
    const batch = immediate.currentInputCount > 1 ? 'batched ' : ''
    if (bytes > 16_000)
      return `large ${batch}tool-output continuation cache miss`
    return `${batch}tool-output continuation cache miss`
  }
  if (
    immediate &&
    immediate.previousInputCount <= 1 &&
    immediate.currentInputCount > 1
  ) {
    return 'fresh full replay after same-turn continuation'
  }
  if (
    cmp.commonPrefixItems !== undefined &&
    cmp.commonPrefixItems <
      Math.min(cmp.previousInputCount, cmp.currentInputCount)
  ) {
    const prev = cmp.firstDiffPrevious
    const cur = cmp.firstDiffCurrent
    if (
      prev?.type === 'function_call_output' ||
      cur?.type === 'function_call_output'
    ) {
      return 'tool output changed at cached prefix boundary'
    }
    if (prev?.type !== cur?.type || prev?.role !== cur?.role) {
      return `input item order/shape changed at index ${cmp.commonPrefixItems}`
    }
    return `input content changed at index ${cmp.commonPrefixItems}`
  }
  if (cliff.promptGrowth > 0 && cliff.uncachedGrowth > 0)
    return 'prompt grew beyond cached prefix'
  return 'cache read dropped without obvious request-shape change'
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function safeJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function hashStable(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

function pct(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${(value * 100).toFixed(1)}%`
}
