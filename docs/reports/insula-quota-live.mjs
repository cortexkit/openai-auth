#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { normalizeInsulaCodexQuota } from '../../packages/core/dist/insula-quota.js'

const coreDir = resolve(import.meta.dir, '../../packages/core')
const { resolveClaustrumConnectionPath } = await import(Bun.resolveSync('@cortexkit/claustrum-client', coreDir))
const {
  connectClaustrumScopedClient,
  readClaustrumEnrollmentToken,
  readVaultRoster,
} = await import(Bun.resolveSync('@cortexkit/common-auth/claustrum', coreDir))

// Only the built normalizer and read-only client are used. Constructing an
// OpenAiVault would allow discovery to rewrite the host's persisted roster.
const [tokenArg, rosterArg, connectionArg] = process.argv.slice(2)
if (!tokenArg || !rosterArg) {
  throw new Error('Usage: bun docs/reports/insula-quota-live.mjs <enrollment-token-path> <roster-path> [connection-file]')
}
const tokenPath = resolve(tokenArg)
const rosterPath = resolve(rosterArg)
const connectionFile = resolveClaustrumConnectionPath(connectionArg)
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const before = await Promise.all([digest(tokenPath), digest(rosterPath)])
await readClaustrumEnrollmentToken(tokenPath)
const roster = await readVaultRoster(rosterPath)
if (!roster) throw new Error('No persisted vault roster')
const client = await connectClaustrumScopedClient({
  connectionFile, storagePath: tokenPath, projectRoot: dirname(rosterPath),
})
try {
  if (!client.insula) throw new Error('Installed common-auth has no insula transport')
  const reply = await client.insula.getUsage()
  if (!reply || !Array.isArray(reply.result) || reply.error !== undefined) throw new Error('Insula returned no usage envelope')
  const now = Date.now()
  for (const row of roster.rows) {
    // Match the consumer's provider/account join, not display labels or emails.
    const entry = reply.result.find((entry) => entry?.provider === 'codex' &&
      typeof entry.account === 'string' && entry.account.trim() === row.accountIdentity &&
      entry.stale === undefined && entry.errorClass === undefined &&
      entry.usage && typeof entry.usage === 'object' && !Array.isArray(entry.usage) &&
      typeof entry.fetchedAt === 'string' && Number.isFinite(Date.parse(entry.fetchedAt)) &&
      now - Date.parse(entry.fetchedAt) < 240_000)
    const normalized = entry ? normalizeInsulaCodexQuota(entry, { fetchedAt: Date.parse(entry.fetchedAt), source: entry.source }) : undefined
    console.log(JSON.stringify({ routeId: row.routeId, account: row.accountIdentity,
      matchedCurrentEntry: Boolean(entry), normalized: normalized ?? null }))
  }
} finally {
  client.close()
}
const after = await Promise.all([digest(tokenPath), digest(rosterPath)])
if (before.some((hash, index) => hash !== after[index])) throw new Error('Enrollment token or roster changed during inspection')
console.log('Read-only check: enrollment token and roster bytes unchanged; usage.get called once.')
