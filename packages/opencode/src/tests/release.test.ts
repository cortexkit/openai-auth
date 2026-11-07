import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const scratch = join(repositoryRoot, 'target/scratch')
const fixtures: string[] = []
const requiredJobs = [
  'check',
  'check-macos',
  'runtime-layout-windows (windows-latest)',
  'runtime-layout-windows (windows-2022)',
]
const versionFiles = [
  'packages/opencode/package.json',
  'packages/pi/package.json',
  'packages/opencode/src/version.ts',
  'README.md',
  'packages/opencode/README.md',
  'packages/pi/README.md',
  'docs/configuration.md',
  'docs/opencode-2.md',
]

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'release-test-'))
  fixtures.push(root)
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  const log = join(root, 'events')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(log, '')
  const gitPath = spawnSync('bash', ['-c', 'command -v git'], {
    encoding: 'utf8',
  })
  if (gitPath.status !== 0 || !gitPath.stdout.trim()) {
    throw new Error(`Cannot find git in Bash: ${gitPath.stderr}`)
  }
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig').replaceAll('\\', '/'),
  }
  writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  function git(...args: string[]) {
    const result = spawnSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: repo,
        encoding: 'utf8',
        env,
      },
    )
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    }
    return result.stdout.trim()
  }
  function script(path: string, content: string) {
    writeFileSync(
      path,
      `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`,
      {
        mode: 0o755,
      },
    )
  }
  copyFileSync(
    join(repositoryRoot, 'scripts/release.sh'),
    join(repo, 'scripts/release.sh'),
  )
  writeFileSync(join(repo, 'scripts/version-sync.mjs'), '// fixture\n')
  for (const path of [...versionFiles, 'source.ts']) {
    mkdirSync(resolve(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), 'before\n')
  }
  script(
    join(repo, 'scripts/gate.sh'),
    `printf "gate %s\\n" "$*" >> "$RELEASE_LOG"\nexit "\${GATE_STATUS:-0}"`,
  )
  script(
    join(bin, 'gh'),
    `printf 'gh %s\n' "$*" >> "$RELEASE_LOG"
if [[ "\${GH_FAIL:-}" == 1 ]]; then echo 'API unavailable' >&2; exit 1; fi
case "$2" in
  "repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=\${INITIAL_SHA}&per_page=100")
    printf '%s\n' "$CI_RUNS_JSON" ;;
  'repos/{owner}/{repo}/actions/runs/42/jobs?per_page=100&filter=latest')
    printf '%s\n' "$CI_JOBS_JSON" ;;
  *) echo "Unexpected gh request: $*" >&2; exit 1 ;;
esac`,
  )
  script(
    join(bin, 'bun'),
    `if [[ "$1" == scripts/version-sync.mjs ]]; then
  printf 'sync %s\n' "$*" >> "$RELEASE_LOG"
  if [[ "\${3:-}" != --dry-run ]]; then
    printf 'after\n' > "$SYNC_PATH"
    case "\${SYNC_EXTRA:-}" in
      tracked) printf 'unsafe\n' > source.ts ;;
      untracked) printf 'unsafe\n' > unexpected.txt ;;
      staged) printf 'unsafe\n' > source.ts; git add source.ts ;;
      rename) mv source.ts README.md ;;
    esac
  fi
elif [[ "$*" == 'run test' ]]; then
  echo suite >> "$RELEASE_LOG"
  exit "\${SUITE_STATUS:-0}"
else
  echo "Unexpected bun invocation: $*" >&2; exit 1
fi`,
  )
  script(
    join(bin, 'git'),
    `if [[ "$1" == push ]]; then
  printf 'push %s\n' "$*" >> "$RELEASE_LOG"
  exit 0
fi
exec "$REAL_GIT" -c core.hooksPath=/dev/null "$@"`,
  )
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release fixture')
  git('config', 'user.email', 'release@example.invalid')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const sha = git('rev-parse', 'HEAD')
  const run = {
    id: 42,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }
  const jobs = requiredJobs.map((name) => ({ name, conclusion: 'success' }))
  function release(
    options: {
      args?: readonly string[]
      runs?: object[]
      jobs?: object[]
      extraEnv?: Record<string, string>
    } = {},
  ) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        // Git Bash rebuilds PATH at startup; export the stubs inside it too.
        'export PATH="$(cd "$FIXTURE_BIN" && pwd):$PATH"\nexec bash scripts/release.sh "$@"',
        'release-fixture',
        ...(options.args ?? ['9.8.7']),
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...env,
          FIXTURE_BIN: bin.replaceAll('\\', '/'),
          REAL_GIT: gitPath.stdout.trim(),
          RELEASE_LOG: log.replaceAll('\\', '/'),
          INITIAL_SHA: sha,
          CI_RUNS_JSON: JSON.stringify({
            workflow_runs: options.runs ?? [run],
          }),
          CI_JOBS_JSON: JSON.stringify({ jobs: options.jobs ?? jobs }),
          SYNC_PATH: 'packages/opencode/src/version.ts',
          ...options.extraEnv,
        },
      },
    )
    return {
      ...result,
      output: result.stdout + result.stderr,
      events: readFileSync(log, 'utf8'),
    }
  }
  return { repo, sha, run, jobs, git, release }
}

describe('release script CI suite selection', () => {
  it('skips the local suite only after exact-SHA CI succeeds on every platform', () => {
    const f = fixture()
    const result = f.release()
    expect(result.output).toContain(
      `Skipping the local suite because CI passed on ${f.sha} on Linux, macOS and Windows.`,
    )
    expect(result.status).toBe(0)
    expect(result.events).toContain('gate --fast\n')
    expect(result.events).not.toContain('suite\n')
    expect(result.events).toContain('push push origin main v9.8.7\n')
    expect(f.git('rev-parse', 'HEAD')).not.toBe(f.sha)
    expect(f.git('rev-parse', 'v9.8.7^{}')).toBe(f.git('rev-parse', 'HEAD'))
    expect(f.git('status', '--porcelain')).toBe('')
  })

  it.each([
    ['red', 'completed', 'failure'],
    ['in-progress', 'in_progress', null],
    ['skipped', 'completed', 'skipped'],
  ])('runs the local suite when CI is %s', (_label, status, conclusion) => {
    const f = fixture()
    const result = f.release({ runs: [{ ...f.run, status, conclusion }] })
    expect(result.status).toBe(0)
    expect(result.output).toContain('Running bun run test: CI for')
    expect(result.events).toContain('gate --fast\nsuite\n')
  })

  it.each(requiredJobs)('runs the local suite when %s is missing', (name) => {
    const f = fixture()
    const result = f.release({
      jobs: f.jobs.filter((job) => job.name !== name),
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain(`${name}=missing`)
    expect(result.events).toContain('suite\n')
  })

  it.each(['failure', 'skipped', null])(
    'runs the local suite when the macOS job conclusion is %s',
    (conclusion) => {
      const f = fixture()
      const result = f.release({
        jobs: f.jobs.map((job) =>
          job.name === 'check-macos' ? { ...job, conclusion } : job,
        ),
      })
      expect(result.status).toBe(0)
      expect(result.output).toContain('check-macos=')
      expect(result.events).toContain('suite\n')
    },
  )

  it.each([
    ['another SHA', { head_sha: '0'.repeat(40) }],
    ['another branch', { head_branch: 'feature' }],
    ['a pull request', { event: 'pull_request' }],
  ])('does not trust CI for %s', (_label, changes) => {
    const f = fixture()
    const result = f.release({ runs: [{ ...f.run, ...changes }] })
    expect(result.status).toBe(0)
    expect(result.output).toContain(`no main-branch CI push run for ${f.sha}`)
    expect(result.events).toContain('suite\n')
  })

  it('falls back to the suite if CI cannot be queried', () => {
    const f = fixture()
    const result = f.release({ extraEnv: { GH_FAIL: '1' } })
    expect(result.status).toBe(0)
    expect(result.output).toContain('could not query CI')
    expect(result.events).toContain('suite\n')
  })
})

describe('release version-sync boundary', () => {
  it.each(versionFiles)('allows the version-sync target %s', (path) => {
    const f = fixture()
    const result = f.release({ extraEnv: { SYNC_PATH: path } })
    expect(result.status).toBe(0)
    expect(result.events).toContain('gate --fast\n')
    expect(result.events).not.toContain('suite\n')
    expect(result.events).toContain('push push origin main v9.8.7\n')
  })

  for (const green of [true, false]) {
    it.each(['tracked', 'untracked', 'staged', 'rename'])(
      `refuses a non-version %s change even when CI is ${green ? 'green' : 'red'}`,
      (kind) => {
        const f = fixture()
        const result = f.release({
          runs: [{ ...f.run, conclusion: green ? 'success' : 'failure' }],
          extraEnv: { SYNC_EXTRA: kind },
        })
        expect(result.status).not.toBe(0)
        expect(result.output).toContain(
          'Error: version sync changed a non-version file:',
        )
        expect(result.events).not.toContain('gate ')
        expect(result.events).not.toContain('suite\n')
        expect(result.events).not.toContain('push ')
        expect(f.git('rev-parse', 'HEAD')).toBe(f.sha)
        expect(f.git('tag', '--list')).toBe('')
      },
    )
  }
})

describe('release previews and existing safety checks', () => {
  it.each(['green', 'red', 'missing macOS'])(
    'previews the %s CI path without checks, commits, tags or pushes',
    (state) => {
      const f = fixture()
      const result = f.release({
        args: ['9.8.7', '--dry'],
        runs: [
          { ...f.run, conclusion: state === 'red' ? 'failure' : 'success' },
        ],
        jobs:
          state === 'missing macOS'
            ? f.jobs.filter((job) => job.name !== 'check-macos')
            : f.jobs,
      })
      expect(result.status).toBe(0)
      expect(result.output).toContain(
        '[DRY RUN] Would run ./scripts/gate.sh --fast.',
      )
      expect(result.output).toContain(
        state === 'green'
          ? `[DRY RUN] Would skip the local suite because CI passed on ${f.sha}`
          : '[DRY RUN] Would run bun run test:',
      )
      expect(result.events).toContain(
        'sync scripts/version-sync.mjs 9.8.7 --dry-run\n',
      )
      expect(result.events).not.toContain('gate ')
      expect(result.events).not.toContain('suite\n')
      expect(result.events).not.toContain('push ')
      expect(f.git('rev-parse', 'HEAD')).toBe(f.sha)
      expect(f.git('tag', '--list')).toBe('')
      expect(f.git('status', '--porcelain')).toBe('')
    },
  )

  it('still stops when the fast gate fails despite green CI', () => {
    const f = fixture()
    const result = f.release({ extraEnv: { GATE_STATUS: '1' } })
    expect(result.status).not.toBe(0)
    expect(result.events).toContain('gate --fast\n')
    expect(result.events).not.toContain('suite\n')
    expect(result.events).not.toContain('push ')
    expect(f.git('rev-parse', 'HEAD')).toBe(f.sha)
    expect(f.git('tag', '--list')).toBe('')
  })

  it('still stops when the fallback suite fails', () => {
    const f = fixture()
    const result = f.release({
      runs: [{ ...f.run, conclusion: 'failure' }],
      extraEnv: { SUITE_STATUS: '1' },
    })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('Error: Tests failed')
    expect(result.events).toContain('gate --fast\nsuite\n')
    expect(result.events).not.toContain('push ')
    expect(f.git('rev-parse', 'HEAD')).toBe(f.sha)
    expect(f.git('tag', '--list')).toBe('')
  })

  it.each([
    { args: ['9.8.7', '--dry-run'] },
    { args: ['9.8.7', '--dry', '--extra'] },
  ])('refuses unrecognized release arguments %j', ({ args }) => {
    const f = fixture()
    const result = f.release({ args })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('the only option is --dry')
    expect(result.events).toBe('')
    expect(f.git('rev-parse', 'HEAD')).toBe(f.sha)
    expect(f.git('tag', '--list')).toBe('')
  })

  it('still refuses a dirty working tree before contacting CI', () => {
    const f = fixture()
    writeFileSync(join(f.repo, 'source.ts'), 'dirty\n')
    const result = f.release()
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('working tree is not clean')
    expect(result.events).toBe('')
  })
})
