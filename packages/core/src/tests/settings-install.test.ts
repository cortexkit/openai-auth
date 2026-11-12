import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import {
  getSettingsDecision,
  recordSettingsDecision,
} from '../settings-decisions.ts'
import {
  canonicalSettingsPath,
  resolveDefaultSettingsStores,
  resolveSettingsInstall,
  type SettingsHost,
  type SettingsInstallOptions,
  type SettingsPathOptions,
  settingsIdentity,
} from '../settings-install.ts'

let root: string
let home: string
let options: SettingsPathOptions
let warnings: string[]
const hosts: SettingsHost[] = ['opencode', 'pi']
const optInVariable = (host: SettingsHost) =>
  host === 'opencode'
    ? 'OPENCODE_OPENAI_AUTH_SETTINGS_FILE'
    : 'PI_OPENAI_AUTH_SETTINGS_FILE'

beforeEach(() => {
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  mkdirSync(scratch, { recursive: true })
  root = realpathSync.native(mkdtempSync(join(scratch, 'settings-install-')))
  home = join(root, 'home')
  mkdirSync(home)
  options = { env: {}, platform: process.platform, homedir: () => home }
  warnings = []
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function install(
  host: SettingsHost,
  overrides: Partial<SettingsInstallOptions> = {},
) {
  const defaults = resolveDefaultSettingsStores(options)
  return resolveSettingsInstall({
    ...options,
    host,
    paths: defaults[host === 'opencode' ? 0 : 1],
    logger: { warn: (message) => warnings.push(message) },
    ...overrides,
  })
}

function seed(path: string, text = '{}') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('settings install targets and default stores', () => {
  it.each(hosts)(
    'a fresh %s install is not separate before any store exists',
    (host) => {
      const result = install(host)
      expect(result.separate).toBe(false)
      expect(result.optIn).toBe(false)
      expect(result.target).toBe(
        process.platform === 'win32'
          ? join(home, 'AppData', 'Roaming', 'cortexkit', 'openai-auth.jsonc')
          : join(home, '.config', 'cortexkit', 'openai-auth.jsonc'),
      )
      expect(result.sources).toEqual([
        {
          host: 'opencode',
          configPath: join(home, '.config', 'opencode', 'openai-auth.json'),
          statePath: join(
            home,
            '.config',
            'opencode',
            'openai-auth-state.json',
          ),
        },
        {
          host: 'pi',
          configPath: join(home, '.pi', 'agent', 'openai-auth.json'),
          statePath: join(home, '.pi', 'agent', 'openai-auth-state.json'),
        },
      ])
    },
  )

  it.each(hosts)(
    '%s follows an absolute XDG_CONFIG_HOME but Pi stays home-based',
    (host) => {
      options.env = { XDG_CONFIG_HOME: join(root, 'sandbox-config') }
      const result = install(host)
      expect(result.separate).toBe(false)
      expect(result.target).toBe(
        join(root, 'sandbox-config', 'cortexkit', 'openai-auth.jsonc'),
      )
      expect(result.sources[0]?.configPath).toBe(
        join(root, 'sandbox-config', 'opencode', 'openai-auth.json'),
      )
      expect(result.sources[1]?.configPath).toBe(
        join(home, '.pi', 'agent', 'openai-auth.json'),
      )
    },
  )

  it.each(['', 'relative-config'])(
    'only an absolute XDG_CONFIG_HOME counts: %j',
    (xdg) => {
      options.env = { XDG_CONFIG_HOME: xdg }
      const defaults = resolveDefaultSettingsStores(options)
      expect(defaults[0].configPath).toBe(
        join(home, '.config', 'opencode', 'openai-auth.json'),
      )
      expect(install('opencode').target).toBe(
        process.platform === 'win32'
          ? join(home, 'AppData', 'Roaming', 'cortexkit', 'openai-auth.jsonc')
          : join(home, '.config', 'cortexkit', 'openai-auth.jsonc'),
      )
    },
  )

  it('the resolved OpenCode config under a relative XDG_CONFIG_HOME is separate', () => {
    options.env = { XDG_CONFIG_HOME: 'relative-config' }
    const result = install('opencode', {
      paths: {
        configPath: join('relative-config', 'opencode', 'openai-auth.json'),
        statePath: join(
          'relative-config',
          'opencode',
          'openai-auth-state.json',
        ),
      },
    })
    expect(result.separate).toBe(true)
    expect(result.sources).toEqual([])
  })

  it('Windows uses APPDATA for settings, never for OpenCode default stores', () => {
    const windowsHome = 'C:\\Users\\tester'
    const env = { APPDATA: 'D:\\roaming', XDG_CONFIG_HOME: 'relative' }
    const paths = {
      configPath: win32.join(
        windowsHome,
        '.config',
        'opencode',
        'openai-auth.json',
      ),
      statePath: win32.join(
        windowsHome,
        '.config',
        'opencode',
        'openai-auth-state.json',
      ),
    }
    const result = install('opencode', {
      env,
      platform: 'win32',
      homedir: () => windowsHome,
      paths,
    })
    expect(result.target).toBe('D:\\roaming\\cortexkit\\openai-auth.jsonc')
    expect(result.sources[0]?.configPath).toBe(
      'C:\\Users\\tester\\.config\\opencode\\openai-auth.json',
    )
    expect(result.separate).toBe(false)
  })

  it('passes the injected environment home to common-auth instead of using the real home', () => {
    const envHome = join(root, 'env-home')
    const env =
      process.platform === 'win32'
        ? { USERPROFILE: envHome }
        : { HOME: envHome }
    const result = install('pi', { env })
    expect(result.target).toBe(
      join(
        envHome,
        ...(process.platform === 'win32'
          ? ['AppData', 'Roaming']
          : ['.config']),
        'cortexkit',
        'openai-auth.jsonc',
      ),
    )
    expect(result.sources[1]?.configPath).toBe(
      join(home, '.pi', 'agent', 'openai-auth.json'),
    )
  })

  it('OpenCode default state follows the plain runtime-layout marker', () => {
    const runtime = join(root, 'state', 'cortexkit', 'openai-auth', 'opencode')
    options.env = { XDG_STATE_HOME: join(root, 'state') }
    expect(resolveDefaultSettingsStores(options)[0].statePath).toBe(
      join(home, '.config', 'opencode', 'openai-auth-state.json'),
    )
    seed(join(runtime, 'layout.json'))
    expect(resolveDefaultSettingsStores(options)[0].statePath).toBe(
      join(runtime, 'openai-auth-state.json'),
    )
  })

  it('OpenCode default state follows the hashed marker under another config home', () => {
    const configHome = join(root, 'config')
    const configDir = join(configHome, 'opencode')
    options.env = {
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(root, 'state'),
    }
    mkdirSync(configDir, { recursive: true })
    const hash = createHash('sha256')
      .update(realpathSync.native(configDir))
      .digest('hex')
      .slice(0, 16)
    const runtime = join(
      root,
      'state',
      'cortexkit',
      'openai-auth',
      `opencode-${hash}`,
    )
    seed(join(runtime, 'layout.json'))
    expect(resolveDefaultSettingsStores(options)[0].statePath).toBe(
      join(runtime, 'openai-auth-state.json'),
    )
  })
})

describe('separate installs and opt-ins', () => {
  it.each(hosts)(
    'an isolated %s config folder is separate before its store exists',
    (host) => {
      const result = install(host, {
        paths: {
          configPath: join(root, 'isolated', 'config.json'),
          statePath: join(root, 'isolated', 'state.json'),
        },
      })
      expect(result.separate).toBe(true)
      expect(result.sources).toEqual([])
    },
  )

  it.each(hosts)('a %s state override alone is not separate', (host) => {
    const defaults = resolveDefaultSettingsStores(options)
    const result = install(host, {
      paths: {
        configPath: defaults[host === 'opencode' ? 0 : 1].configPath,
        statePath: join(root, 'override-state.json'),
      },
    })
    expect(result.separate).toBe(false)
    expect(result.sources).toEqual(
      defaults.map((source) =>
        source.host === host
          ? { ...source, statePath: join(root, 'override-state.json') }
          : source,
      ),
    )
  })

  it('a Pi agent folder that fell back to the home store is not separate', () => {
    const result = install('pi', {
      env: { PI_CODING_AGENT_DIR: join(root, 'empty-agent') },
    })
    expect(result.separate).toBe(false)
    expect(result.sources).toHaveLength(2)
  })

  for (const host of hosts) {
    it.each(['', 'relative.jsonc'])(
      `a relative or empty ${host} opt-in does not count: %j`,
      (value) => {
        const result = install(host, { env: { [optInVariable(host)]: value } })
        expect(result.optIn).toBe(false)
        expect(result.sources).toHaveLength(2)
        expect(warnings).toEqual([])
      },
    )

    it(`an absolute ${host} opt-in wins over the separate test and sources only that host`, () => {
      const paths = {
        configPath: join(root, 'isolated', 'config.json'),
        statePath: join(root, 'isolated', 'state.json'),
      }
      const target = join(root, 'chosen.jsonc')
      const result = install(host, {
        env: { [optInVariable(host)]: target },
        paths,
      })
      expect(result.target).toBe(target)
      expect(result.optIn).toBe(true)
      expect(result.separate).toBe(false)
      expect(result.sources).toEqual([{ host, ...paths }])
    })

    it(`a ${host} opt-in with the default config has no source, even with a state override`, () => {
      const defaults = resolveDefaultSettingsStores(options)
      const result = install(host, {
        env: { [optInVariable(host)]: join(root, 'chosen.jsonc') },
        paths: {
          configPath: defaults[host === 'opencode' ? 0 : 1].configPath,
          statePath: join(root, 'custom-state.json'),
        },
      })
      expect(result.optIn).toBe(true)
      expect(result.sources).toEqual([])
    })
  }
})

describe('store collisions and environment boundaries', () => {
  for (const host of hosts) {
    for (const present of [false, true]) {
      it.each([0, 1, 2, 3])(
        `${host} rejects default store file %i, present=${present}, with one warning`,
        (index) => {
          const defaults = resolveDefaultSettingsStores(options)
          const files = defaults.flatMap((store) => [
            store.configPath,
            store.statePath,
          ])
          const target = files[index] as string
          if (present) seed(target)
          const result = install(host, {
            env: { [optInVariable(host)]: target },
          })
          expect(result.optIn).toBe(false)
          expect(result.target).not.toBe(target)
          expect(warnings).toHaveLength(1)
          expect(warnings[0]).toContain(optInVariable(host))
        },
      )

      it.each(['configPath', 'statePath'] as const)(
        `${host} rejects an aliased own override %s, present=${present}`,
        (field) => {
          const actual = join(root, 'actual')
          const alias = join(root, 'alias')
          mkdirSync(actual)
          symlinkSync(actual, alias, 'junction')
          const paths = {
            configPath: join(actual, 'nested', 'custom.json'),
            statePath: join(actual, 'nested', 'custom.state.json'),
          }
          if (present) seed(paths[field])
          const target = join(
            alias,
            'nested',
            field === 'configPath' ? 'custom.json' : 'custom.state.json',
          )
          const result = install(host, {
            env: { [optInVariable(host)]: target },
            paths,
          })
          expect(result.optIn).toBe(false)
          expect(result.separate).toBe(true)
          expect(warnings).toHaveLength(1)
        },
      )
    }

    it(`${host} rejects an alias of the other host's not-yet-created default store`, () => {
      const alias = join(root, 'home-alias')
      symlinkSync(home, alias, 'junction')
      const target =
        host === 'opencode'
          ? join(alias, '.pi', 'agent', 'openai-auth-state.json')
          : join(alias, '.config', 'opencode', 'openai-auth.json')
      const result = install(host, { env: { [optInVariable(host)]: target } })
      expect(result.optIn).toBe(false)
      expect(warnings).toHaveLength(1)
    })

    it(`${host} never reads an override or any variable of the other host`, () => {
      const otherPrefix = host === 'opencode' ? 'PI_' : 'OPENCODE_'
      const env = new Proxy(
        { [optInVariable(host)]: join(root, 'chosen.jsonc') },
        {
          get(target, key: string) {
            if (key.startsWith(otherPrefix))
              throw new Error(`Read other host variable ${key}`)
            return Reflect.get(target, key)
          },
        },
      )
      expect(install(host, { env }).optIn).toBe(true)
    })
  }

  it('the cross-host default resolver reads no host-prefixed variable', () => {
    const env = new Proxy(
      {},
      {
        get(_target, key: string) {
          if (key.startsWith('OPENCODE_') || key.startsWith('PI_'))
            throw new Error(`Read host variable ${key}`)
          return undefined
        },
      },
    )
    expect(resolveDefaultSettingsStores({ ...options, env })).toHaveLength(2)
  })

  it('rejects the marker-selected default state file, not just its old path', () => {
    const runtime = join(
      home,
      '.local',
      'state',
      'cortexkit',
      'openai-auth',
      'opencode',
    )
    seed(join(runtime, 'layout.json'))
    const result = install('pi', {
      env: {
        PI_OPENAI_AUTH_SETTINGS_FILE: join(runtime, 'openai-auth-state.json'),
      },
    })
    expect(result.optIn).toBe(false)
    expect(warnings).toHaveLength(1)
  })
})

describe('resolved identities and process decisions', () => {
  it.each([false, true])(
    'a default config override through an alias is not separate, present=%s',
    (present) => {
      const alias = join(root, 'home-alias')
      symlinkSync(home, alias, 'junction')
      for (const host of hosts) {
        const ownDefault =
          resolveDefaultSettingsStores(options)[host === 'opencode' ? 0 : 1]
        if (present) seed(ownDefault.configPath)
        const configPath = ownDefault.configPath.replace(home, alias)
        const result = install(host, {
          paths: { configPath, statePath: join(root, 'state-override') },
        })
        expect(result.separate).toBe(false)
        expect(result.configIdentity).toBe(
          canonicalSettingsPath(ownDefault.configPath),
        )
        const optedIn = install(host, {
          paths: { configPath, statePath: join(root, 'state-override') },
          env: { [optInVariable(host)]: join(root, 'chosen.jsonc') },
        })
        expect(optedIn.sources).toEqual([])
      }
    },
  )

  it('a missing file resolves through its nearest existing real ancestor', () => {
    const actual = join(root, 'actual')
    const alias = join(root, 'alias')
    mkdirSync(actual)
    symlinkSync(actual, alias, 'junction')
    const path = join(alias, 'not', 'created', 'settings.jsonc')
    expect(canonicalSettingsPath(path)).toBe(
      join(actual, 'not', 'created', 'settings.jsonc'),
    )
    seed(join(actual, 'not', 'created', 'settings.jsonc'))
    expect(canonicalSettingsPath(path)).toBe(realpathSync.native(path))
  })

  it('settingsIdentity keeps the identity it first resolved for a path', () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const alias = join(root, 'identity-alias')
    mkdirSync(first)
    mkdirSync(second)
    symlinkSync(first, alias, 'junction')
    const path = join(alias, 'openai-auth.json')
    expect(settingsIdentity(path)).toBe(join(first, 'openai-auth.json'))
    // Repointing the link changes the canonical path, but not the identity
    // request readers already keyed this config by.
    rmSync(alias, { recursive: true, force: true })
    symlinkSync(second, alias, 'junction')
    expect(canonicalSettingsPath(path)).toBe(join(second, 'openai-auth.json'))
    expect(settingsIdentity(path)).toBe(join(first, 'openai-auth.json'))
  })

  it('keeps the first decision per config identity and leaves other configs undecided', () => {
    const alias = join(root, 'alias')
    symlinkSync(home, alias, 'junction')
    const config = join(home, 'new', 'config.json')
    const aliasedConfig = join(alias, 'new', 'config.json')
    expect(getSettingsDecision(config)).toBeUndefined()
    expect(recordSettingsDecision(config, 'shared')).toBe('shared')
    expect(getSettingsDecision(aliasedConfig)).toBe('shared')
    expect(recordSettingsDecision(aliasedConfig, 'legacy')).toBe('shared')
    seed(config)
    expect(getSettingsDecision(config)).toBe('shared')
    const separate = join(root, 'separate', 'config.json')
    expect(getSettingsDecision(separate)).toBeUndefined()
    expect(recordSettingsDecision(separate, 'separate')).toBe('separate')
    expect(getSettingsDecision(config)).toBe('shared')
    expect(recordSettingsDecision(join(root, 'legacy.json'), 'legacy')).toBe(
      'legacy',
    )
  })

  it('shares decisions with another loaded copy of the module', async () => {
    const config = join(root, 'config.json')
    recordSettingsDecision(config, 'legacy')
    const moduleUrl = `${new URL('../settings-decisions.ts', import.meta.url).href}?copy`
    const other = await import(moduleUrl)
    expect(other.getSettingsDecision(config)).toBe('legacy')
    expect(other.recordSettingsDecision(config, 'shared')).toBe('legacy')
  })
})
