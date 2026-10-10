import {
  type ActionDefinition,
  CommandError,
  type CommandInvocation,
  type CommandMenu,
  type CommandMenuOptions,
  createCommandMenu,
  type MenuAction,
  type MenuItem,
  type SectionContent,
  type StoreSectionSlot,
} from '@cortexkit/common-auth/commands'
import type { PoolRow, PoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  getKillswitchThresholdsForAccount,
} from './accounts'
import { isRecord } from './util/record'
import {
  isVaultMenuConnected,
  type MenuVault,
  quotaReadingAge,
  readVaultMenu,
  setAsideDetail,
  VAULT_MODE_LOCAL_NOTE,
  vaultAccountName,
} from './vault-account-menu'

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

/** Delegate built-in actions without changing their input validation or confirmation requirements. */
function forwardAction(
  menu: CommandMenu,
  sectionId: string,
  action: MenuAction,
  itemId?: string,
): ActionDefinition {
  const confirmation = action.confirm?.irreversible
    ? { irreversible: true as const, confirm: action.confirm.message }
    : { ...(action.confirm ? { confirm: action.confirm.message } : {}) }
  return {
    id: action.id,
    label: action.label,
    knobs: action.knobs,
    ...confirmation,
    run: async ({ values, invocation }) => {
      const result = await menu.apply(
        {
          command: menu.command,
          sectionId,
          ...(itemId ? { itemId } : {}),
          actionId: action.id,
          values,
          confirmed: true,
        },
        invocation,
      )
      return {
        ok: result.ok,
        text: result.text,
        ...(result.code ? { code: result.code } : {}),
      }
    },
  }
}

/**
 * Show the id from the local account list when its label is missing, without
 * writing that display name back to the account files. Vault accounts are
 * display-only entries because their credentials belong to the vault. Their
 * killswitch floors (the minimum quota left before the account stops being
 * used) are plugin settings under `killswitch.accounts`, keyed by the vault
 * route id, which is the key the request path reads them by.
 */
export function menuStore(store: PoolStore, vault?: MenuVault): PoolStore {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'read')
        return async () => {
          const load = await target.read()
          if (load.status !== 'ready') return load
          const named = {
            ...load,
            rows: load.rows.map((row) => ({
              ...row,
              label: row.label ?? row.id,
            })),
          }
          if (!vault) return named
          const view = await readVaultMenu(vault)
          if (!isVaultMenuConnected(view)) return named
          // Connected (vault mode): the vault's accounts replace the local
          // rows; only they serve this host.
          const rows: PoolRow[] = [
            ...view.status.accounts.map(
              (row): PoolRow => ({
                id: row.routeId,
                label: vaultAccountName(row),
                type: 'oauth',
                enabled: row.enabled,
                identity: row.accountIdentity,
                quota: row.quota,
                hasEntry: false,
                needsFirstReading: false,
                candidate: false,
              }),
            ),
          ]
          return { ...load, rows }
        }
      if (key === 'readSettings')
        return async () => {
          const read = await target.readSettings()
          if (read.status === 'error' || !vault) return read
          const view = await readVaultMenu(vault)
          const killswitch = record(read.settings.killswitch)
          if (!isVaultMenuConnected(view) || !read.settings.killswitch)
            return read
          const accounts = record(killswitch.accounts)
          for (const row of view.status.accounts) {
            accounts[row.routeId] = getKillswitchThresholdsForAccount(
              { version: 1, accounts: [], ...read.settings } as AccountStorage,
              row.routeId,
            )
          }
          return {
            ...read,
            settings: {
              ...read.settings,
              killswitch: { ...killswitch, accounts },
            },
          }
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function createVaultCommandMenu(
  options: CommandMenuOptions & { store: PoolStore },
  vault: MenuVault,
): CommandMenu {
  const localMenu = createCommandMenu(options)
  const projection = createCommandMenu({
    command: options.command,
    title: options.title,
    store: menuStore(options.store, vault),
    accounts: options.accounts,
    quota: options.quota,
    limits: options.limits,
    routing: options.routing,
    ...(options.extraLocks ? { extraLocks: options.extraLocks } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const build = async (
    slot: StoreSectionSlot,
    invocation: CommandInvocation,
  ): Promise<SectionContent> => {
    const view = await readVaultMenu(vault)
    // Connected means vault mode: the projection lists the vault's accounts
    // alone, and no local row is shown, set aside or polled.
    const connected = isVaultMenuConnected(view)
    const source = connected ? projection : localMenu
    const model = (await source.open(invocation)).menu
    const section = model.sections.find((section) => section.id === slot)
    if (!section)
      throw new CommandError('unavailable', 'The account menu is unavailable.')
    if (!connected)
      return {
        lines: section.lines,
        items: section.items.map((item: MenuItem) => ({
          ...item,
          actions: item.actions.map((action) =>
            forwardAction(source, slot, action, item.id),
          ),
        })),
        actions: section.actions.map((action) =>
          forwardAction(source, slot, action),
        ),
      }
    const vaultById = new Map(
      view.status.accounts.map((row) => [row.routeId, row]),
    )
    const now = (options.now ?? Date.now)()
    const items = section.items.map((item: MenuItem) => {
      const remote = vaultById.get(item.id)
      const age =
        slot !== 'limits' ? quotaReadingAge(remote?.quota, now) : undefined
      const detail =
        remote && slot === 'accounts'
          ? `Vault · ${remote.credentialType === 'oauth' ? 'login' : 'API key'} · ${remote.state} · ${remote.enabled ? 'enabled' : 'declined'} · ${model.sections.find((section) => section.id === 'quota')?.items.find((quota) => quota.id === item.id)?.detail}`
          : item.detail
      return {
        id: item.id,
        label: item.label,
        detail: [detail, age].filter(Boolean).join(' · '),
        ...(item.facts ? { facts: item.facts } : {}),
        // A vault account is managed in the vault; only its killswitch
        // floors (Limits) are this plugin's settings.
        actions:
          remote && slot !== 'limits'
            ? []
            : item.actions.map((action) =>
                forwardAction(source, slot, action, item.id),
              ),
      }
    })
    const candidates = view.status.accounts
      .filter((row) => view.routes.has(row.routeId))
      .map((row) => ({ value: row.routeId, label: vaultAccountName(row) }))
    const actions =
      slot === 'quota'
        ? candidates.length === 0
          ? []
          : [
              {
                id: 'check',
                label: 'Check now',
                knobs: [
                  {
                    kind: 'choice' as const,
                    id: 'account',
                    label: 'Account',
                    choices: [
                      { value: '*', label: 'All accounts' },
                      ...candidates,
                    ],
                    value: '*',
                  },
                ],
                run: async ({
                  values,
                }: Parameters<ActionDefinition['run']>[0]) => {
                  // Only vault accounts are polled, through the vault; no
                  // local credential is asked for a reading.
                  const current = await readVaultMenu(vault)
                  const selected = String(values.account)
                  const vaultIds = [...current.routes].filter(
                    (id) => selected === '*' || selected === id,
                  )
                  for (const id of vaultIds) {
                    const result = await vault.pollQuota(id)
                    if (!result.ok)
                      throw new CommandError(
                        'quota-check-failed',
                        `${id}: ${result.error ?? 'vault unavailable'}`,
                      )
                  }
                  return `Checked quota for ${vaultIds.length} account(s).`
                },
              },
            ]
        : section.actions.map((action) => forwardAction(source, slot, action))
    return {
      lines:
        slot === 'accounts'
          ? [
              `${view.routes.size} vault account(s) can route. ${VAULT_MODE_LOCAL_NOTE}`,
            ]
          : section.lines,
      items,
      actions,
    }
  }
  const connectedMenu = createCommandMenu({
    ...options,
    accounts: undefined,
    quota: undefined,
    limits: undefined,
    replace: {
      accounts: {
        title: 'Accounts',
        build: (invocation) => build('accounts', invocation),
      },
      quota: {
        title: 'Quota',
        build: (invocation) => build('quota', invocation),
      },
      limits: {
        title: 'Limits',
        build: (invocation) => build('limits', invocation),
      },
    },
    extras: options.extras?.map((section) =>
      section.id !== 'reset'
        ? section
        : {
            ...section,
            build: async (invocation) => {
              const content = await section.build(invocation)
              const view = await readVaultMenu(vault)
              const load = await options.store.read()
              return {
                ...content,
                items: content.items?.map((item) => {
                  const row =
                    load.status === 'ready'
                      ? load.rows.find((row) => row.id === item.id)
                      : undefined
                  const aside = row ? setAsideDetail(row, view) : undefined
                  return {
                    ...item,
                    label: aside ? `${item.label} · ${aside}` : item.label,
                  }
                }),
              }
            },
          },
    ),
  })
  const current = async () => {
    if (!isVaultMenuConnected(await readVaultMenu(vault))) return localMenu
    await vault.refresh()
    return connectedMenu
  }
  return {
    command: options.command,
    open: async (invocation) => (await current()).open(invocation),
    apply: async (request, invocation) =>
      (await current()).apply(request, invocation),
  }
}
