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
  isVaultShadowed,
  type MenuVault,
  quotaReadingAge,
  readVaultMenu,
  setAsideDetail,
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
 * Add vault rows only to returned read data, never to the local account files.
 * Writes use the underlying store. A vault row's only built-in write sets its
 * quota reserve floors under the route id that request admission reads.
 */
function menuStore(
  store: PoolStore,
  vault: MenuVault,
  includeVaultRows = true,
): PoolStore {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'read')
        return async () => {
          const load = await target.read()
          if (load.status !== 'ready') return load
          const view = await readVaultMenu(vault)
          if (!isVaultMenuConnected(view)) return load
          const rows: PoolRow[] = [
            ...load.rows.map((row) => ({ ...row, label: row.label ?? row.id })),
            ...(includeVaultRows ? view.status.accounts : []).map(
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
          if (read.status === 'error') return read
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
  quotaCheckIncludesVault = false,
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
  // Account management must use only the real roster: move/reorder cannot name a vault route.
  const localActions = createCommandMenu({
    command: options.command,
    title: options.title,
    store: menuStore(options.store, vault, false),
    accounts: options.accounts,
    ...(options.extraLocks ? { extraLocks: options.extraLocks } : {}),
  })
  const build = async (
    slot: StoreSectionSlot,
    invocation: CommandInvocation,
  ): Promise<SectionContent> => {
    const view = await readVaultMenu(vault)
    const connected = isVaultMenuConnected(view)
    const source = connected ? projection : localMenu
    const model = (await source.open(invocation)).menu
    const localAccounts =
      slot === 'accounts' && connected
        ? (await localActions.open(invocation)).menu.sections.find(
            (section) => section.id === 'accounts',
          )?.items
        : undefined
    const section = model.sections.find((section) => section.id === slot)
    if (!section)
      throw new CommandError('unavailable', 'The account menu is unavailable.')
    const load = await options.store.read()
    const rows = load.status === 'ready' ? load.rows : []
    const byId = new Map(rows.map((row) => [row.id, row]))
    const vaultById = new Map(
      view.status.accounts.map((row) => [row.routeId, row]),
    )
    const now = (options.now ?? Date.now)()
    const items = section.items.map((item: MenuItem) => {
      const local = byId.get(item.id)
      const remote = vaultById.get(item.id)
      const aside = connected && local ? setAsideDetail(local, view) : undefined
      const age =
        connected && slot !== 'limits'
          ? quotaReadingAge(local?.quota ?? remote?.quota, now)
          : undefined
      const detail =
        remote && slot === 'accounts'
          ? `Vault · ${remote.credentialType === 'oauth' ? 'login' : 'API key'} · ${remote.state} · ${remote.enabled ? 'enabled' : 'declined'} · ${model.sections.find((section) => section.id === 'quota')?.items.find((quota) => quota.id === item.id)?.detail}`
          : item.detail
      return {
        id: item.id,
        label: item.label,
        detail: [detail, aside, age].filter(Boolean).join(' · '),
        ...(item.facts ? { facts: item.facts } : {}),
        actions:
          (remote && slot !== 'limits') || (aside && slot === 'limits')
            ? []
            : (
                localAccounts?.find((local) => local.id === item.id)?.actions ??
                item.actions
              ).map((action) =>
                forwardAction(
                  localAccounts ? localActions : source,
                  slot,
                  action,
                  item.id,
                ),
              ),
      }
    })
    if (!connected)
      return {
        lines: section.lines,
        items,
        actions: section.actions.map((action) =>
          forwardAction(source, slot, action),
        ),
      }
    const shadowed = rows.filter((row) => isVaultShadowed(row, view)).length
    const canRoute =
      view.routes.size +
      rows.filter(
        (row) =>
          row.candidate && row.type === 'oauth' && !isVaultShadowed(row, view),
      ).length
    const candidates = [
      ...rows
        .filter((row) => row.candidate && !isVaultShadowed(row, view))
        .map((row) => ({ value: row.id, label: row.label ?? row.id })),
      ...view.status.accounts
        .filter((row) => view.routes.has(row.routeId))
        .map((row) => ({ value: row.routeId, label: vaultAccountName(row) })),
    ]
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
                  invocation,
                }: Parameters<ActionDefinition['run']>[0]) => {
                  // Resolve ownership again at apply time, before asking any local credential for a reading.
                  const current = await readVaultMenu(vault)
                  const latest = await options.store.read()
                  const selected = String(values.account)
                  const localIds = (
                    latest.status === 'ready' ? latest.rows : []
                  )
                    .filter(
                      (row) =>
                        row.candidate &&
                        !isVaultShadowed(row, current) &&
                        (selected === '*' || selected === row.id),
                    )
                    .map((row) => row.id)
                  if (localIds.length > 0) {
                    if (options.quota?.check)
                      await options.quota.check(localIds, invocation)
                    else {
                      for (const id of localIds)
                        options.store.requestReading(id)
                      await options.store.pullsSettled()
                    }
                  }
                  const vaultIds = [...current.routes].filter(
                    (id) => selected === '*' || selected === id,
                  )
                  for (const id of vaultIds) {
                    if (
                      localIds.length > 0 &&
                      options.quota?.check &&
                      quotaCheckIncludesVault
                    )
                      continue
                    const result = await vault.pollQuota(id)
                    if (!result.ok)
                      throw new CommandError(
                        'quota-check-failed',
                        `${id}: ${result.error ?? 'vault unavailable'}`,
                      )
                  }
                  return `Checked quota for ${localIds.length + vaultIds.length} account(s).`
                },
              },
            ]
        : section.actions.map((action) => forwardAction(source, slot, action))
    return {
      lines:
        slot === 'accounts' && load.status === 'ready'
          ? [
              `${canRoute} account(s) can route, ${shadowed} local row(s) set aside.`,
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
