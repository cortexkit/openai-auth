import { basename } from 'node:path'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
  readClaustrumEnrollmentStatus,
} from '@cortexkit/common-auth/claustrum'
import {
  assertHostsStopped,
  createProcessFence,
  findExecutableOnPath,
  type ProcessFence,
  type SetupHost,
  type SetupIO,
  type SetupPlugin,
} from '@cortexkit/common-auth/setup'
import {
  beginAccountLogin,
  openUrl,
  VAULT_FAMILY,
  vaultEnrollmentName,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import piPackage from '../../pi/package.json'
import { getPiAccountPaths } from '../../pi/src/store-paths'
import packageInfo from '../package.json'
import { getAccountPaths } from './core/account-paths'
import { opencodeAuthIsEnvBacked } from './core/host-slot'
import { opencode1HostSlot } from './v2/host-slot'

interface SetupDependencies {
  beginLogin?: typeof beginAccountLogin
  openBrowser?: typeof openUrl
  fence?: ProcessFence
  io?: SetupIO
  print?: (message: string) => void
}

export function createSetupPlugin(deps: SetupDependencies = {}): SetupPlugin {
  const print = deps.print ?? console.log
  const fence = deps.fence ?? createProcessFence()
  const paths = {
    opencode: {
      stateDir: vaultStateDir(getAccountPaths().statePath),
      host: 'opencode',
    },
    pi: {
      stateDir: vaultStateDir(getPiAccountPaths().statePath),
      host: 'pi',
    },
  }
  const assertLocal = async (host: SetupHost) => {
    const authority = await enrollmentAuthority(
      hostEnrollmentPaths(paths[host]),
      vaultEnrollmentName(host),
    )
    if (authority !== 'local') {
      throw new Error(
        `${host} is enrolled in Claustrum or its enrollment is unreadable. Disconnect it from the vault before using local sign-in.`,
      )
    }
  }

  return {
    packages: { opencode: packageInfo.name, pi: piPackage.name },
    version: packageInfo.version,
    displayName: 'OpenAI Auth',
    slashCommand: '/openai',
    vault: {
      connectionFile: resolveClaustrumConnectionPath(),
      hosts: {
        opencode: {
          name: vaultEnrollmentName('opencode'),
          paths: paths.opencode,
        },
        pi: { name: vaultEnrollmentName('pi'), paths: paths.pi },
      },
    },
    async beforeRegister(host, mode) {
      // Vault enrollment must not read, rewrite or migrate local credentials.
      if (mode === 'claustrum') {
        const enrollment = await readClaustrumEnrollmentStatus(
          hostEnrollmentPaths(paths[host]),
          vaultEnrollmentName(host),
        )
        const approvedName =
          enrollment.state === 'approved' ? enrollment.approvedName : undefined
        const grantName =
          approvedName ??
          ('proposedName' in enrollment
            ? enrollment.proposedName
            : vaultEnrollmentName(host))
        if (!approvedName) {
          print(
            'The enrollment state does not record an approved name. The command below uses the proposed name; if the vault approved a different name, substitute it.',
          )
        }
        print(
          `Allow this host to read OpenAI accounts with:\n  ck auth grant --principal enrolled:${grantName} --selector-kind category --selector ${VAULT_FAMILY.category} --operation read`,
        )
        if (host === 'opencode') {
          print(
            'Then run opencode auth login and choose ChatGPT accounts in the vault to activate vault routing without local sign-in.',
          )
        }
        return
      }
      await assertLocal(host)
    },
    async signInLocal(host, context) {
      await assertLocal(host)
      if (host === 'pi') {
        print('Start Pi and run /login openai-codex to sign in with Pi itself.')
        return
      }
      if (context.opencodeGeneration !== '1') {
        const executable = basename(
          findExecutableOnPath('opencode2', deps.io) ??
            findExecutableOnPath('opencode', deps.io) ??
            'opencode',
        )
        // OpenCode 2 activates the pool through a connection in its own database;
        // writing OpenCode 1's login file cannot create that connection.
        print(
          `In OpenCode 2, run ${executable} auth login openai and choose "ChatGPT (openai-auth pool, browser)" or "ChatGPT (openai-auth pool, headless)" to sign in to the account pool and activate it.`,
        )
      }
      if (context.opencodeGeneration === '2') return
      if (opencodeAuthIsEnvBacked(process.env)) {
        throw new Error(
          'Unset OPENCODE_AUTH_CONTENT before local setup sign-in.',
        )
      }
      const slot = opencode1HostSlot()
      const input = { path: { id: 'openai' } }
      if ((await slot.get(input)) !== undefined) {
        print(
          'OpenCode already has an OpenAI login. Use opencode auth login to change it.',
        )
        return
      }
      const begin = deps.beginLogin ?? beginAccountLogin
      const controller = new AbortController()
      const headless = Boolean(
        process.env.SSH_CONNECTION ||
          process.env.SSH_TTY ||
          (process.platform === 'linux' &&
            !process.env.DISPLAY &&
            !process.env.WAYLAND_DISPLAY),
      )
      const options = {
        version: packageInfo.version,
        signal: controller.signal,
      }
      let login: Awaited<ReturnType<typeof beginAccountLogin>>
      let browserFlow = !headless
      try {
        login = await begin({ ...options, headless })
      } catch (error) {
        if (headless) throw error
        browserFlow = false
        print('Browser callback unavailable; using device-code sign-in.')
        login = await begin({ version: packageInfo.version, headless: true })
      }
      if (browserFlow) {
        if (!(deps.openBrowser ?? openUrl)(login.url)) {
          controller.abort()
          await login.completion.catch(() => {})
          print('Browser unavailable; using device-code sign-in.')
          login = await begin({ version: packageInfo.version, headless: true })
        }
      }
      print(`${login.url}\n${login.instructions}`)
      const account = await login.completion
      await assertHostsStopped(fence)
      await assertLocal(host)
      // The OpenCode 1 login adapter preserves other providers and refuses to
      // overwrite a changed OpenAI login. First plugin startup moves this login
      // to the pool's main row.
      await slot.set({
        ...input,
        body: {
          type: 'oauth',
          access: account.access,
          refresh: account.refresh,
          expires: account.expires,
          ...(account.accountId ? { accountId: account.accountId } : {}),
        },
      })
      print(
        'Signed in to OpenCode. The first plugin start adopts this login into the account pool.',
      )
    },
    async migrate(host) {
      print(
        `${host}: account migration runs on first plugin start; setup leaves existing credentials unchanged.`,
      )
    },
  }
}
