import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { randomBytes, randomInt } from 'node:crypto'
import { dirname, join } from 'node:path'

export const MANIFEST_LOCK = {
  ttlMs: 30_000,
  renewEveryMs: 10_000,
  ownerKeys: ['tenant', 'pid', 'claimed_at_ms', 'nonce'] as const,
  staleTargetRe: /^\.lock\.stale-\d+-[A-Za-z0-9_-]+$/,
}

const HANDLE_FILE_MAX_BYTES = 256 * 1024
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HANDLE_RE = /^ckh_[A-Za-z0-9_-]{43}$/
const FORBIDDEN_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype'])

export type ManifestHandleAccount = {
  label: string
  handle: string
  credential_id: string
  superseded?: string[]
}

export type ManifestHandleProvider = {
  provider: string
  shape: 'api' | 'oauth'
  serve: string
  accounts: ManifestHandleAccount[]
}

export type ManifestHandleFile = {
  version: 1
  providers: ManifestHandleProvider[]
}

type ManifestLockOwner = {
  tenant: string
  pid: number
  claimed_at_ms: number
  nonce: string
}

type ManifestLockTestOptions = {
  ttlMs?: number
  renewEveryMs?: number
  retryMinMs?: number
  retryMaxMs?: number
  beforeEvict?: () => Promise<void>
  afterEvict?: () => void
  beforeManifestRename?: (lockPath: string) => Promise<void>
}

let testOptions: ManifestLockTestOptions | undefined

export function __setManifestLockTestOptions(options?: ManifestLockTestOptions): void {
  testOptions = options
}

function randomToken(): string {
  return randomBytes(16).toString('base64url')
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value) && !FORBIDDEN_IDENTIFIERS.has(value)
}

function parseManifest(value: unknown): ManifestHandleFile {
  if (!value || typeof value !== 'object') throw new Error('handle file must be an object')
  const file = value as Record<string, unknown>
  if (file.version !== 1 || !Array.isArray(file.providers)) {
    throw new Error('handle file must have version 1 and providers')
  }
  const providerIds = new Set<string>()
  for (const [index, provider] of file.providers.entries()) {
    if (!provider || typeof provider !== 'object') throw new Error(`provider ${index} must be an object`)
    const item = provider as Record<string, unknown>
    if (!isIdentifier(item.provider)) throw new Error(`provider ${index} has invalid provider`)
    if (providerIds.has(item.provider)) throw new Error(`provider ${index} duplicates provider ${item.provider}`)
    providerIds.add(item.provider)
  }
  const providers = file.providers.map((provider, index): ManifestHandleProvider => {
    const item = provider as Record<string, unknown>
    const providerId = item.provider as string
    if (item.shape !== 'api' && item.shape !== 'oauth') throw new Error(`provider ${index} has invalid shape`)
    if (typeof item.serve !== 'string' || !item.serve) throw new Error(`provider ${index} requires serve`)
    if (!Array.isArray(item.accounts) || item.accounts.length === 0) {
      throw new Error(`provider ${index} has invalid accounts`)
    }
    const labels = new Set<string>()
    const accounts = item.accounts.map((account, accountIndex): ManifestHandleAccount => {
      if (!account || typeof account !== 'object') throw new Error(`provider ${index} has invalid accounts`)
      const entry = account as Record<string, unknown>
      if (!isIdentifier(entry.label)) throw new Error(`provider ${index} has an invalid account label`)
      if (labels.has(entry.label)) throw new Error(`provider ${index} duplicates account label ${entry.label}`)
      labels.add(entry.label)
      if (typeof entry.handle !== 'string' || !HANDLE_RE.test(entry.handle)) {
        throw new Error(`provider ${index} account ${entry.label} has invalid handle`)
      }
      if (typeof entry.credential_id !== 'string' || !entry.credential_id) {
        throw new Error(`provider ${index} account ${entry.label} has invalid credential id`)
      }
      if (entry.superseded !== undefined &&
        (!Array.isArray(entry.superseded) || entry.superseded.some((handle) => typeof handle !== 'string' || !HANDLE_RE.test(handle)))) {
        throw new Error(`provider ${index} account ${entry.label} has invalid superseded handle`)
      }
      return {
        label: entry.label,
        handle: entry.handle,
        credential_id: entry.credential_id,
        ...(entry.superseded === undefined ? {} : { superseded: [...entry.superseded] as string[] }),
      }
    })
    return { provider: providerId, shape: item.shape, serve: item.serve, accounts }
  })
  return { version: 1, providers }
}

function parseOwner(source: string): ManifestLockOwner {
  const value = JSON.parse(source) as unknown
  if (!value || typeof value !== 'object') throw new Error('manifest lock owner invalid')
  const owner = value as Record<string, unknown>
  if (Object.keys(owner).sort().join('\0') !== [...MANIFEST_LOCK.ownerKeys].sort().join('\0') ||
    typeof owner.tenant !== 'string' ||
    typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) ||
    typeof owner.claimed_at_ms !== 'number' || !Number.isFinite(owner.claimed_at_ms) ||
    typeof owner.nonce !== 'string') {
    throw new Error('manifest lock owner invalid')
  }
  return owner as ManifestLockOwner
}

async function readOwner(ownerPath: string): Promise<ManifestLockOwner> {
  return parseOwner(await readFile(ownerPath, 'utf8'))
}

async function writeOwner(lockPath: string, owner: ManifestLockOwner): Promise<void> {
  const ownerPath = join(lockPath, 'owner')
  const temporary = join(lockPath, `owner.${process.pid}.${randomToken()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(`${JSON.stringify(owner)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, ownerPath)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withManifestLock<T>(
  path: string,
  tenant: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withManifestLockCommit(path, tenant, async () => fn())
}

async function withManifestLockCommit<T>(
  path: string,
  tenant: string,
  fn: (commitLease: () => Promise<void>) => Promise<T> | T,
): Promise<T> {
  const lockPath = `${path}.lock`
  const ownerPath = join(lockPath, 'owner')
  const ttlMs = testOptions?.ttlMs ?? MANIFEST_LOCK.ttlMs
  const renewEveryMs = testOptions?.renewEveryMs ?? MANIFEST_LOCK.renewEveryMs
  const retryMinMs = testOptions?.retryMinMs ?? 25
  const retryMaxMs = testOptions?.retryMaxMs ?? 75
  const nonce = randomToken()
  const startedAt = Date.now()
  const deadline = startedAt + ttlMs

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      await writeOwner(lockPath, { tenant, pid: process.pid, claimed_at_ms: Date.now(), nonce })
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        if (errorCode(error) !== 'ENOENT') await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }

    let observed: ManifestLockOwner | undefined
    try {
      observed = await readOwner(ownerPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        if (Date.now() >= deadline) throw new Error('manifest lock busy')
      }
    }
    if (observed && startedAt - observed.claimed_at_ms >= ttlMs) {
      await testOptions?.beforeEvict?.()
      const stalePath = `${lockPath}.stale-${observed.claimed_at_ms}-${randomToken()}`
      try {
        await rename(lockPath, stalePath)
        const moved = await readOwner(join(stalePath, 'owner')).catch(() => undefined)
        if (moved?.nonce === observed.nonce && moved.claimed_at_ms === observed.claimed_at_ms) {
          testOptions?.afterEvict?.()
          continue
        }
        await rename(stalePath, lockPath).catch(() => {})
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
    if (Date.now() >= deadline) throw new Error('manifest lock busy')
    const jitter = randomInt(retryMinMs, retryMaxMs + 1)
    await sleep(Math.min(jitter, Math.max(1, deadline - Date.now())))
  }

  let renewal = Promise.resolve()
  let renewalFailed = false
  let renewalStopped = false
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (renewalFailed) return
      try {
        const current = await readOwner(ownerPath)
        if (current.nonce !== nonce || Date.now() - current.claimed_at_ms >= ttlMs) throw new Error('lease lost')
        await writeOwner(lockPath, { ...current, claimed_at_ms: Date.now() })
      } catch {
        renewalFailed = true
      }
    })
  }, renewEveryMs)
  timer.unref?.()

  const commitLease = async (): Promise<void> => {
    if (!renewalStopped) {
      renewalStopped = true
      clearInterval(timer)
      await renewal
    }
    const current = await readOwner(ownerPath).catch(() => undefined)
    if (renewalFailed || !current || current.nonce !== nonce || Date.now() - current.claimed_at_ms >= ttlMs) {
      throw new Error('manifest lock renewal failed; write aborted')
    }
  }

  try {
    const result = await fn(commitLease)
    if (renewalFailed) throw new Error('manifest lock renewal failed; write aborted')
    return result
  } finally {
    if (!renewalStopped) clearInterval(timer)
    await renewal
    const current = await readOwner(ownerPath).catch(() => undefined)
    if (!current || current.nonce !== nonce || Date.now() - current.claimed_at_ms >= ttlMs) {
      console.warn('manifest lock lease lost, not releasing', { path, tenant })
    } else {
      const releasePath = `${lockPath}.release-${nonce}`
      try {
        await rename(lockPath, releasePath)
        const moved = await readOwner(join(releasePath, 'owner')).catch(() => undefined)
        if (!moved || moved.nonce !== nonce || Date.now() - moved.claimed_at_ms >= ttlMs) {
          await rename(releasePath, lockPath).catch(() => {})
          console.warn('manifest lock lease lost, not releasing', { path, tenant })
        } else {
          await rm(releasePath, { recursive: true, force: true })
        }
      } catch {
        console.warn('manifest lock lease lost, not releasing', { path, tenant })
      }
    }
  }
}

async function readManifest(path: string): Promise<ManifestHandleFile> {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { version: 1, providers: [] }
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('handle file must be a regular file')
  if ((metadata.mode & 0o777) !== 0o600) throw new Error('handle file mode must be exactly 0600')
  const source = await readFile(path)
  if (source.byteLength > HANDLE_FILE_MAX_BYTES) throw new Error('handle file exceeds 256 KiB')
  return parseManifest(JSON.parse(source.toString('utf8')))
}

function foreignBlocks(file: ManifestHandleFile, tenant: string): string[] {
  return file.providers.filter((provider) => provider.serve !== tenant).map((provider) => JSON.stringify(provider))
}

async function prepareManifestParent(path: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentStat = await stat(parent)
  if (!parentStat.isDirectory()) throw new Error('handle file parent must be a directory')
  if ((parentStat.mode & 0o002) !== 0 && (parentStat.mode & 0o1000) === 0) {
    throw new Error('handle file parent is world-writable without sticky bit')
  }
  await chmod(parent, 0o700)
}

async function writeManifestAtomic(
  path: string,
  file: ManifestHandleFile,
  commitLease: () => Promise<void>,
): Promise<void> {
  const parent = dirname(path)
  const bytes = Buffer.from(JSON.stringify(file))
  if (bytes.byteLength > HANDLE_FILE_MAX_BYTES) throw new Error('handle file exceeds 256 KiB')
  const temporary = join(parent, `.${path.split('/').pop()}.${process.pid}.${randomToken()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temporary, 0o600)
    await testOptions?.beforeManifestRename?.(`${path}.lock`)
    await commitLease()
    await rename(temporary, path)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

export async function writeHandleFileLocked(
  path: string,
  tenant: string,
  mutate: (file: ManifestHandleFile) => void | ManifestHandleFile | Promise<void | ManifestHandleFile>,
): Promise<void> {
  await prepareManifestParent(path)
  await withManifestLockCommit(path, tenant, async (commitLease) => {
    const before = await readManifest(path)
    const working = structuredClone(before)
    const result = await mutate(working)
    const next = parseManifest(result ?? working)
    const beforeForeign = foreignBlocks(before, tenant)
    if (JSON.stringify(foreignBlocks(next, tenant)) !== JSON.stringify(beforeForeign)) {
      throw new Error('manifest mutation changed another tenant block')
    }
    await writeManifestAtomic(path, next, commitLease)
    const metadata = await lstat(path)
    if ((metadata.mode & 0o777) !== 0o600) throw new Error('manifest readback mode is not 0600')
    const readback = await readManifest(path)
    if (JSON.stringify(readback) !== JSON.stringify(next)) throw new Error('manifest readback differs')
    if (JSON.stringify(foreignBlocks(readback, tenant)) !== JSON.stringify(beforeForeign)) {
      throw new Error('manifest readback changed another tenant block')
    }
  })
}
