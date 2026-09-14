/**
 * Custody manifest reader — secure, narrow path parser for the opencode
 * Claude-vault handle file. The owning filter is provider:'openai' /
 * shape:'oauth' / serve:'openai-auth'; consumers (enrollment, predicates,
 * the resolver) consult the parsed file but NEVER receive raw strings
 * (handles, errors) that could leak through logs or thrown-error messages.
 *
 * The transport's `ManifestHandleFile` type is the source of truth for the
 * structural rules (version, providers, identifier regexes, handle regex,
 * no prototype keys). This file owns only the I/O path: resolver + parser +
 * lstat/O_NOFOLLOW/fstat + 0600/uid + parent + 256 KiB cap + bounded read.
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat as nodeLstat,
  open as nodeOpen,
  stat as nodeStat,
  readFile,
} from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import type {
  ManifestHandleAccount,
  ManifestHandleFile,
  ManifestHandleProvider,
} from '../vendor/claustrum-client/manifest-lock.ts'

const HANDLE_FILE_MAX_BYTES = 256 * 1024
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HANDLE_RE = /^ckh_[A-Za-z0-9_-]{43}$/
const FORBIDDEN_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype'])
const TENANT = 'openai-auth'
const OWNING_PROVIDER = 'openai'
const OWNING_SHAPE = 'oauth'
const OWNING_SERVE = 'openai-auth'

// Default location: $CLAUSTRUM_OPENCODE_HANDLES, then XDG_CONFIG_HOME or
// ~/.config/cortexkit/opencode-handles.json. The floor pre-set in
// tests/setup-env.ts makes this safe under the test runner.
export function defaultCustodyManifestPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CLAUSTRUM_OPENCODE_HANDLES) return env.CLAUSTRUM_OPENCODE_HANDLES
  const configHome =
    env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : '.config')
  return join(configHome, 'cortexkit', 'opencode-handles.json')
}

export type CustodyManifestReadResult =
  | { ok: true; value: ManifestHandleFile; revision: string }
  | { ok: false; reason: 'absent' }
  | { ok: false; reason: 'tooLarge'; message: string }
  | {
      ok: false
      reason: 'permissions' | 'unsafeParent' | 'notRegular' | 'symlink'
      message: string
    }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'unreadable'; message: string }

export type CustodyManifestIo = {
  lstat?: (path: string) => Promise<CustodyStat>
  stat?: (path: string) => Promise<CustodyStat>
  readFile?: (path: string, encoding: 'utf8') => Promise<string>
  open?: (path: string) => Promise<CustodyDescriptor>
  currentUid?: () => number | undefined
}

type CustodyStat = {
  isFile(): boolean
  isDirectory?(): boolean
  isSymbolicLink?(): boolean
  mode: number
  size?: number
  uid?: number
  mtimeMs?: number
}

type CustodyDescriptor = {
  stat(): Promise<CustodyStat>
  read(options: {
    buffer: Buffer
    offset: number
    length: number
    position: number
  }): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

function currentUid(): number | undefined {
  return process.getuid?.() ?? userInfo().uid
}

export async function readCustodyManifest(
  path = defaultCustodyManifestPath(),
  io: CustodyManifestIo = {},
): Promise<CustodyManifestReadResult> {
  const lstat = io.lstat ?? nodeLstat
  const stat = io.stat ?? nodeStat
  const readFileImpl = io.readFile ?? readFile
  const openImpl =
    io.open ??
    ((candidate: string) =>
      nodeOpen(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ) as unknown as Promise<CustodyDescriptor>)

  let descriptor: CustodyDescriptor | undefined
  try {
    let metadata: CustodyStat
    try {
      if (io.lstat || io.readFile) {
        // Callers that injected their own lstat/readFile opt out of the bounded
        // open() path — bounded read needs a real FD to size-check before read.
        metadata = await lstat(path)
      } else {
        descriptor = await openImpl(path)
        metadata = await descriptor.stat()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, reason: 'absent' }
      }
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        return { ok: false, reason: 'symlink', message: 'symlink' }
      }
      return {
        ok: false,
        reason: 'unreadable',
        message: `unreadable (${errno(error)})`,
      }
    }
    if (metadata.isSymbolicLink?.()) {
      return { ok: false, reason: 'symlink', message: 'symlink' }
    }
    if (!metadata.isFile()) {
      return { ok: false, reason: 'notRegular', message: 'not regular' }
    }
    if ((metadata.size ?? 0) > HANDLE_FILE_MAX_BYTES) {
      return { ok: false, reason: 'tooLarge', message: 'too large' }
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      return { ok: false, reason: 'permissions', message: 'mode' }
    }
    const uid = io.currentUid ?? currentUid
    const expectedUid = uid()
    if (
      expectedUid !== undefined &&
      metadata.uid !== undefined &&
      metadata.uid !== expectedUid
    ) {
      return { ok: false, reason: 'permissions', message: 'uid' }
    }

    let parent: CustodyStat
    try {
      parent = await stat(dirname(path))
    } catch {
      return { ok: false, reason: 'unsafeParent', message: 'parent' }
    }
    if (!parent.isDirectory?.()) {
      return { ok: false, reason: 'unsafeParent', message: 'parent not dir' }
    }
    if (
      expectedUid !== undefined &&
      parent.uid !== undefined &&
      parent.uid !== expectedUid
    ) {
      return { ok: false, reason: 'unsafeParent', message: 'parent uid' }
    }
    // A permissive parent (group- or world-writable, OR group/other readable)
    // is the TOCTOU surface the manifest-lock writer guards against. Refuse
    // the read so a racing writer cannot race-replace the manifest we are
    // about to parse, and so a co-tenant with read access to the parent
    // cannot inspect the owning tenant's handle file. Mode 0o700 (owner only)
    // is the only safe default.
    if ((parent.mode & 0o077) !== 0) {
      return { ok: false, reason: 'unsafeParent', message: 'parent mode' }
    }

    let source: string
    try {
      if (descriptor) {
        // Bounded read: read up to cap+1 bytes from the already-fstat'd FD so a
        // TOCTOU write that grows the file between fstat and read cannot drive
        // the read past the cap.
        const cap = HANDLE_FILE_MAX_BYTES
        const buffer = Buffer.alloc(cap + 1)
        const { bytesRead } = await descriptor.read({
          buffer,
          offset: 0,
          length: cap + 1,
          position: 0,
        })
        if (bytesRead > cap) {
          return { ok: false, reason: 'tooLarge', message: 'too large' }
        }
        source = buffer.subarray(0, bytesRead).toString('utf8')
      } else {
        source = await readFileImpl(path, 'utf8')
      }
    } catch {
      return {
        ok: false,
        reason: 'unreadable',
        message: `unreadable (${errno(descriptor ? 'fd' : 'io')})`,
      }
    }
    if (Buffer.byteLength(source, 'utf8') > HANDLE_FILE_MAX_BYTES) {
      return { ok: false, reason: 'tooLarge', message: 'too large' }
    }

    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      // Stable message + no cause: the caller path is log/throw surfaces,
      // both of which would otherwise leak the partial source (which may
      // contain a ckh_… handle) when wrapped into a higher-level error.
      return { ok: false, reason: 'invalid', message: 'invalid JSON' }
    }
    const parsed = parseOwningProvider(value)
    if (!parsed) {
      return { ok: false, reason: 'invalid', message: 'invalid manifest' }
    }
    return { ok: true, value: parsed, revision: manifestRevision(source) }
  } finally {
    await descriptor?.close()
  }
}

export function manifestRevision(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function errno(error: unknown): string {
  if (typeof error === 'string') return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code ?? 'EIO'
}

/**
 * Extract the opencode-claustrum owning provider block from a parsed manifest.
 * Other tenants (anthropic-auth, deepseek, …) are ignored — this consumer
 * owns the openai/oauth/openai-auth block and nothing else. Validation here
 * mirrors the manifest-lock primitive's rules so the read path enforces the
 * same identifier and handle shape on disk.
 */
function parseOwningProvider(value: unknown): ManifestHandleFile | null {
  if (!value || typeof value !== 'object') return null
  const file = value as Record<string, unknown>
  if (file.version !== 1 || !Array.isArray(file.providers)) return null
  if (!isSafeIdentifier(OWNING_PROVIDER)) return null
  // An empty providers list means no ownership has been declared yet. The
  // read path treats that as 'absent' rather than 'invalid' so callers can
  // distinguish a never-onboarded manifest from a corrupted one — but for
  // the resolver path an empty list has no effect either way (no enrollment
  // is possible).
  const providers: ManifestHandleProvider[] = []
  for (const provider of file.providers) {
    if (!provider || typeof provider !== 'object') return null
    const item = provider as Record<string, unknown>
    if (item.provider !== OWNING_PROVIDER) continue
    if (item.shape !== OWNING_SHAPE) continue
    if (item.serve !== OWNING_SERVE) continue
    if (!Array.isArray(item.accounts) || item.accounts.length === 0) return null
    const labels = new Set<string>()
    const accounts: ManifestHandleAccount[] = []
    for (const account of item.accounts) {
      if (!account || typeof account !== 'object') return null
      const entry = account as Record<string, unknown>
      const label = entry.label
      const handle = entry.handle
      const credential_id = entry.credential_id
      if (typeof label !== 'string' || !isSafeIdentifier(label)) return null
      if (labels.has(label)) return null
      labels.add(label)
      if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) return null
      if (typeof credential_id !== 'string' || !credential_id) return null
      accounts.push({ label, handle, credential_id })
    }
    providers.push({
      provider: OWNING_PROVIDER,
      shape: OWNING_SHAPE,
      serve: OWNING_SERVE,
      accounts,
    })
  }
  return { version: 1, providers }
}

function isSafeIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value) && !FORBIDDEN_IDENTIFIERS.has(value)
}

/**
 * Tenant-stable identifier used by the manifest-lock writer when the
 * consumer needs to add or replace an account on disk. Tests + the
 * resolver both depend on this constant being stable.
 */
export const CUSTODY_MANIFEST_TENANT = TENANT

// Sentinel exposed for callers that want to assert the owning filter
// without re-hardcoding it (e.g. fixtures).
export const CUSTODY_OWNING_PROVIDER = OWNING_PROVIDER
export const CUSTODY_OWNING_SHAPE = OWNING_SHAPE
export const CUSTODY_OWNING_SERVE = OWNING_SERVE

/** Returns the owning tenant's case-exact account-label to vault-handle map. */
export function custodyManifestHandles(
  manifest: CustodyManifestReadResult,
): ReadonlyMap<string, string> {
  if (!manifest.ok) return new Map()
  const handles = new Map<string, string>()
  for (const provider of manifest.value.providers) {
    if (
      provider.provider !== OWNING_PROVIDER ||
      provider.shape !== OWNING_SHAPE ||
      provider.serve !== OWNING_SERVE
    ) {
      continue
    }
    for (const account of provider.accounts) {
      handles.set(account.label, account.handle)
    }
  }
  return handles
}
