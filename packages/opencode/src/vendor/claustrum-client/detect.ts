import { readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  readConnectionFile,
  type Endpoint as SubcEndpoint,
} from '@cortexkit/subc-client'

export type ClaustrumEndpoint = SubcEndpoint

export type ClaustrumDetection =
  | {
      status: 'available'
      schema: number
      wireVersion: number
      endpoints: ClaustrumEndpoint[]
    }
  | { status: 'absent'; path: string }
  | { status: 'malformed'; path: string; reason: string }

const PRODUCTION_FILE_NAME = 'subc-connection.json'
const TEMP_PREFIX = 'subc-'
const TEMP_SUFFIX = '.connection.json'

// The default discovery order MUST mirror `ck` / the daemon, because a client that picks a
// different file ends up talking to the wrong daemon. The Rust source of truth (sibling
// pin, NOT regenerated here) is:
//
//   crates/credentials-module/src/bin/credentials_cli.rs :: discover_subc_connection_file
//     -> XDG_RUNTIME_DIR/subc-connection.json, else
//        ~/.local/share/cortexkit/run/subc-connection.json, else
//        <tempdir>/subc-<token>.connection.json  (glob; ambiguity REFUSES)
//
//   crates/subc-core/src/bootstrap.rs :: connection_file_path_with_source
//     -> XDG_RUNTIME_DIR/subc-connection.json, else
//        <tempdir>/subc-<user_connection_token()>.connection.json
//     where user_connection_token() is the UID on unix (via a probe-file UID read),
//     else a sanitized USER/USERNAME/HOME/USERPROFILE value, else "unknown".
//
// The OLD client derived `${uid}` itself via `process.getuid()`, but the daemon may
// produce a different token (sanitized user on macOS, the literal "unknown" if all of
// the lookups miss). The glob is the only way to mirror the daemon without re-deriving
// the token (which is filesystem-side-effecting per the Rust side comment).
// The home tier resolves from `$HOME` byte-for-byte, mirroring `non_empty_env("HOME")`
// in `discover_subc_connection_file`: only the empty string is absent, and whitespace
// is not trimmed. The Rust code does NOT fall back to a `getpwuid`-style lookup; the
// client must not either, or an operator who points HOME at a per-test fixture loses
// the daemon they started there.
function homeTierPath(): string | undefined {
  const homeEnv = process.env.HOME
  return homeEnv ? join(homeEnv, '.local', 'share', 'cortexkit', 'run', PRODUCTION_FILE_NAME) : undefined
}

function highestPriorityAbsentMarker(): string {
  const runtime = process.env.XDG_RUNTIME_DIR?.trim()
  if (runtime) return join(runtime, PRODUCTION_FILE_NAME)
  const home = homeTierPath()
  if (home) return home
  // HOME unset — the Rust tier falls through to the tempdir glob with no fixed path.
  // Surface the os-reported home so `detectClaustrumConnection` returns an `absent`
  // path the operator can fix; without this, the caller gets a misleading `./...` path.
  return join(userInfo().homedir, '.local', 'share', 'cortexkit', 'run', PRODUCTION_FILE_NAME)
}

function findExistingConnectionPath(): string | undefined {
  const runtime = process.env.XDG_RUNTIME_DIR?.trim()
  if (runtime) {
    const p = join(runtime, PRODUCTION_FILE_NAME)
    if (safeIsFile(p)) return p
  }
  const home = homeTierPath()
  if (home && safeIsFile(home)) return home
  const matches = listSubcConnectionFiles(tmpdir())
  // A single matching file IS the daemon; multiple matches mean different OS users
  // happened to share the temp dir. Picking one would route credential-bearing
  // requests at another user's daemon, so REFUSE both picks and the absent path.
  return matches.length === 1 ? matches[0] : undefined
}

export function getDefaultClaustrumConnectionPath(): string {
  return findExistingConnectionPath() ?? highestPriorityAbsentMarker()
}

export function resolveClaustrumConnectionPath(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.CLAUSTRUM_SUBC_CONNECTION?.trim() ||
    getDefaultClaustrumConnectionPath()
  )
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function listSubcConnectionFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir) as string[]
  } catch {
    return []
  }
  const matches: string[] = []
  for (const name of entries) {
    if (typeof name !== 'string') continue
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue
    const candidate = join(dir, name)
    if (safeIsFile(candidate)) matches.push(candidate)
  }
  matches.sort()
  return matches
}

// The transport's typed reader validates `wire_version` against PROTOCOL_VERSION but does
// not currently surface the value. Read it from the raw JSON so detection reports what the
// daemon actually advertised, with the PROTOCOL_VERSION fallback for legacy files that
// omitted the additive field.
async function readAdvertisedWireVersion(path: string): Promise<number | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { wire_version?: unknown }
    return typeof parsed.wire_version === 'number' ? parsed.wire_version : undefined
  } catch {
    return undefined
  }
}

export async function detectClaustrumConnection(
  explicitPath?: string,
): Promise<ClaustrumDetection> {
  const path = resolveClaustrumConnectionPath(explicitPath)
  let value: Awaited<ReturnType<typeof readConnectionFile>>
  try {
    value = await readConnectionFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent', path }
    }
    return {
      status: 'malformed',
      path,
      reason: 'connection file could not be read or validated',
    }
  }

  const advertised = await readAdvertisedWireVersion(path)
  return {
    status: 'available',
    schema: value.schema,
    wireVersion: advertised ?? PROTOCOL_VERSION,
    endpoints: value.endpoints,
  }
}
