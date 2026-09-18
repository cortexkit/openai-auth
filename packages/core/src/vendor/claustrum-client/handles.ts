import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat as nodeLstat, open as nodeOpen, readFile, realpath, stat as nodeStat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export const HANDLE_FILE_CONTRACT = {
  maxBytes: 256 * 1024,
  mode: 0o600,
  // Shape only: identifier validity also rejects FORBIDDEN_IDENTIFIERS; use
  // identifierIsValid for validation so callers do not accept parser-rejected labels.
  labelRe: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  handleRe: /^ckh_[A-Za-z0-9_-]{43}$/,
} as const

const FORBIDDEN_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype'])

export class HandleFileValidationError extends Error {
  override name = 'HandleFileValidationError'
}

export type HandleAccount = {
  label: string
  handle: string
  credential_id: string
  superseded?: string[]
}
export type HandleProvider = {
  provider: string
  shape: 'api' | 'oauth'
  serve: string
  accounts: HandleAccount[]
}
export type OpenCodeHandleFileV1 = { version: 1; providers: HandleProvider[] }

function isAccount(value: unknown): value is HandleAccount {
  if (!value || typeof value !== 'object') return false
  const account = value as Record<string, unknown>
  return typeof account.label === 'string' && typeof account.handle === 'string' &&
    typeof account.credential_id === 'string' &&
    (account.superseded === undefined ||
      (Array.isArray(account.superseded) && account.superseded.every((handle) => typeof handle === 'string')))
}

function handleIsValid(handle: unknown): handle is string {
  return typeof handle === 'string' && HANDLE_FILE_CONTRACT.handleRe.test(handle)
}

export function identifierIsValid(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_FILE_CONTRACT.labelRe.test(value) && !FORBIDDEN_IDENTIFIERS.has(value)
}

function invalid(message: string): never {
  throw new HandleFileValidationError(message)
}

export function parseHandleFile(value: unknown): OpenCodeHandleFileV1 {
  if (!value || typeof value !== 'object') invalid('handle file must be an object')
  const file = value as Record<string, unknown>
  if (file.version !== 1 || !Array.isArray(file.providers)) {
    invalid('handle file must have version 1 and providers')
  }
  const providerIds = new Set<string>()
  const providers = file.providers.map((provider, index): HandleProvider => {
    if (!provider || typeof provider !== 'object') invalid(`provider ${index} must be an object`)
    const item = provider as Record<string, unknown>
    if (!identifierIsValid(item.provider)) invalid(`provider ${index} has invalid provider`)
    if (providerIds.has(item.provider)) invalid(`provider ${index} duplicates provider ${item.provider}`)
    providerIds.add(item.provider)
    if (item.shape !== 'api' && item.shape !== 'oauth') invalid(`provider ${index} has invalid shape`)
    if (typeof item.serve !== 'string' || !item.serve) invalid(`provider ${index} requires serve`)
    if (!Array.isArray(item.accounts) || item.accounts.length === 0 || !item.accounts.every(isAccount)) {
      invalid(`provider ${index} has invalid accounts`)
    }
    const labels = new Set<string>()
    for (const account of item.accounts) {
      if (!identifierIsValid(account.label)) invalid(`provider ${index} has an invalid account label`)
      if (labels.has(account.label)) invalid(`provider ${index} duplicates account label ${account.label}`)
      labels.add(account.label)
      if (!handleIsValid(account.handle)) invalid(`provider ${index} account ${account.label} has invalid handle`)
      // Segment 2 of the credential id must BE the provider block it sits in. Without
      // this the check was non-empty-string only, so an `oauth:openai` binding parsed
      // cleanly inside an `anthropic` block -- a cross-provider smuggle that every
      // tenant reading this manifest would have honoured. Two peer tenants found the
      // same hole in their own parsers independently.
      //
      // SCOPED TO SEGMENT 2 ONLY, deliberately. Segment 1 (the kind) is an OPEN SET --
      // `oauth:`, `chatgpt:`, `antigravity:`, `apikey:` are all live in this vault today
      // -- so a kind allowlist would refuse real ids. Segment 3+ (the label) is
      // operator-chosen and may be absent: main is the 2-segment `oauth:anthropic`,
      // fallbacks are 3-segment. Constraining either would reject the deployment this
      // contract describes.
      //
      // NO SEGMENT MAY BE EMPTY. Segment 2 alone is what fences the provider, but a
      // position-1 check ignores the rest of the string, and that left two ids passing
      // that name credentials which cannot exist: `:anthropic:x` (empty kind) and
      // `oauth:anthropic:` (empty label) both satisfy "segment 2 is the provider"
      // literally. Neither is a smuggle; both defer a GUARANTEED resolve-time failure
      // past the door, and under custody a resolve-time failure on a tombstoned account
      // is a dark route rather than a refused row.
      //
      // It also removes an asymmetry nobody designed and everyone would read as a bug:
      // `oauth::anthropic` rejected while `:anthropic:x` passed, purely because the
      // check indexed position 1 and ignored positions 0 and 2. Agreed with the peer
      // tenant and mirrored on their side, so this is chosen rather than defaulted --
      // the previous behaviour was two independent defaults that happened to differ.
      //
      // The emptiness guard is ALSO explicit rather than a consequence: `''.split(':')`
      // yields `['']`, whose `[1]` is `undefined` and cannot equal a provider string,
      // so an empty id would reject anyway -- but that is a coincidence doing
      // load-bearing work, and the check this replaced (`!account.credential_id`) was
      // the emptiness guard. NO TEST DISTINGUISHES THAT ONE (empty rejects with or
      // without it, verified by removal), so it is kept for a future reader who loosens
      // the comparison, not for an arm it could never redden. The non-empty-SEGMENT
      // rule below is different: it reddens, and is pinned.
      const segments = account.credential_id.split(':')
      if (!account.credential_id || segments[1] !== item.provider || segments.some((segment) => segment.length === 0)) {
        invalid(`provider ${index} account ${account.label} has invalid credential id`)
      }
      if (account.superseded?.some((handle) => !handleIsValid(handle))) {
        invalid(`provider ${index} account ${account.label} has invalid superseded handle`)
      }
    }
    return {
      provider: item.provider,
      shape: item.shape,
      serve: item.serve,
      accounts: item.accounts.map((account) => ({
        ...account,
        ...(account.superseded === undefined ? {} : { superseded: account.superseded }),
      })),
    }
  })
  return { version: 1, providers }
}

type HandleFileStat = {
  isFile(): boolean
  isDirectory?(): boolean
  isSymbolicLink?(): boolean
  mode: number
  size?: number
  uid?: number
  mtimeMs?: number
}
type HandleFileDescriptor = {
  read?(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }> | { bytesRead: number }
  stat(): Promise<HandleFileStat>
  readFile(options: { encoding: 'utf8' }): Promise<string>
  close(): Promise<void>
}
export type HandleFileIo = {
  stat?: (path: string) => Promise<HandleFileStat>
  lstat?: (path: string) => Promise<HandleFileStat>
  readFile?: (path: string, encoding: 'utf8') => Promise<string>
  open?: (path: string) => Promise<HandleFileDescriptor>
  currentUid?: () => number | undefined
}

export function defaultHandleFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUSTRUM_OPENCODE_HANDLES) return env.CLAUSTRUM_OPENCODE_HANDLES
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : '.config')
  return join(configHome, 'cortexkit', 'opencode-handles.json')
}

function currentUid(): number | undefined {
  return process.getuid?.() ?? userInfo().uid
}

type HandleFileSnapshot = {
  file: OpenCodeHandleFileV1
  source?: string
  mtimeMs?: number
}

async function readBounded(descriptor: HandleFileDescriptor, cap: number): Promise<{ buffer: Buffer; bytes: number }> {
  if (!descriptor.read) throw new Error('readBounded requires a descriptor exposing read()')
  const buffer = Buffer.alloc(cap + 1)
  let total = 0
  while (total < cap + 1) {
    const chunk = await descriptor.read(buffer, total, buffer.length - total, total)
    if (chunk.bytesRead === 0) break
    total += chunk.bytesRead
  }
  return { buffer, bytes: total > cap ? -1 : total }
}

async function readHandleSnapshot(path = defaultHandleFilePath(), io: HandleFileIo = {}): Promise<HandleFileSnapshot> {
  const stat = io.stat ?? nodeStat
  const lstat = io.lstat ?? nodeLstat
  const read = io.readFile ?? readFile
  const openFd = io.open ?? ((candidate: string) => nodeOpen(candidate, constants.O_RDONLY | constants.O_NOFOLLOW))
  let descriptor: HandleFileDescriptor | undefined
  try {
    let metadata: HandleFileStat
    try {
      if (io.lstat || io.readFile) {
        metadata = await lstat(path)
      } else {
        descriptor = await openFd(path)
        metadata = await descriptor.stat()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: { version: 1, providers: [] } }
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') invalid('handle file must not be a symlink')
      invalid(`cannot stat handle file: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (metadata.isSymbolicLink?.()) invalid('handle file must not be a symlink')
    if (!metadata.isFile()) invalid('handle file must be a regular file')
    if ((metadata.size ?? 0) > HANDLE_FILE_CONTRACT.maxBytes) invalid('handle file exceeds 256 KiB')
    if ((metadata.mode & 0o777) !== HANDLE_FILE_CONTRACT.mode) invalid('handle file mode must be exactly 0600')
    const uid = io.currentUid ?? currentUid
    const expectedUid = uid()
    if (expectedUid !== undefined && metadata.uid !== undefined && metadata.uid !== expectedUid) {
      invalid('handle file is not owned by the current uid')
    }
    let parent: HandleFileStat
    try {
      parent = await stat(dirname(path))
    } catch (error) {
      invalid(`cannot stat handle file parent: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!parent.isDirectory?.()) invalid('handle file parent must be a directory')
    if (expectedUid !== undefined && parent.uid !== undefined && parent.uid !== expectedUid) {
      invalid('handle file parent is not owned by the current uid')
    }
    // GROUP-WRITABLE COUNTS, NOT ONLY WORLD-WRITABLE. Directory write permission governs
    // unlink and create, so anyone who can write the parent can replace a mode-0600 file
    // wholesale however tightly the file itself is locked. The owner check above does not
    // close it: a directory I own can still be 0770, and then any other uid in that group
    // can swap the handle file for one of theirs. A cross-uid attacker is not conceded by
    // this threat model the way a same-uid one is.
    //
    // Sticky exempts both bits for one reason: with it set, a writer may only unlink files
    // they own. Mirrors the Rust check in opencode_files.rs; the two must not drift.
    if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) {
      invalid('handle file parent is group- or world-writable without sticky bit')
    }
    // EVERY ANCESTOR, NOT JUST THIS ONE, OR THE GUARANTEE DOES NOT COMPOSE. The immediate
    // parent being 0700 protects nothing when a directory above it is group-writable:
    // anyone who can create and unlink there renames it aside and substitutes their own
    // tree. Walk to '/' rather than $HOME -- a stopping point read from the environment is
    // attacker-influenceable and undefined when unset.
    //
    // realpath FIRST: an unresolved walk is defeated by a symlink component pointing
    // somewhere permissive, and every individual stat still passes while the loop is about
    // a path we never read through.
    //
    // Mirrors refuse_writable_ancestor in subc-transport 0.7.0 and in opencode_files.rs;
    // three implementations of one rule must not drift.
    let resolved: string | undefined
    try {
      resolved = await realpath(dirname(path))
    } catch {
      // Unresolvable: the read that follows reports the real errno, and refusing here
      // would replace a precise failure with a permissions verdict about a path we could
      // not resolve.
      resolved = undefined
    }
    if (resolved !== undefined) {
      let component = resolved
      for (;;) {
        let ancestor: HandleFileStat | undefined
        try {
          ancestor = await stat(component)
        } catch {
          ancestor = undefined
        }
        if (ancestor && (ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0) {
          invalid(`handle file ancestor ${component} is group- or world-writable without sticky bit`)
        }
        const next = dirname(component)
        if (next === component) break
        component = next
      }
    }
    let source: string
    try {
      if (descriptor) {
        const { buffer, bytes } = await readBounded(descriptor, HANDLE_FILE_CONTRACT.maxBytes)
        if (bytes === -1) invalid('handle file exceeds 256 KiB')
        source = buffer.subarray(0, bytes).toString('utf8')
      } else {
        source = await read(path, 'utf8')
      }
    } catch (error) {
      if (error instanceof HandleFileValidationError) throw error
      invalid(`cannot read handle file: ${error instanceof Error ? error.message : String(error)}`)
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      invalid('handle file contains invalid JSON')
    }
    return { file: parseHandleFile(value), source, mtimeMs: metadata.mtimeMs }
  } finally {
    await descriptor?.close()
  }
}

export async function readHandleFile(path = defaultHandleFilePath(), io: HandleFileIo = {}): Promise<OpenCodeHandleFileV1> {
  return (await readHandleSnapshot(path, io)).file
}

export async function handleFileRevision(path = defaultHandleFilePath(), io: HandleFileIo = {}): Promise<string> {
  const snapshot = await readHandleSnapshot(path, io)
  if (snapshot.source === undefined) invalid('cannot revise absent handle file')
  return `${snapshot.mtimeMs ?? 0}:${createHash('sha256').update(snapshot.source).digest('hex')}`
}
