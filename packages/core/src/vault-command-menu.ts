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
import { formatQuota, projectQuota } from '@cortexkit/common-auth/quota'
import type { PoolRow, PoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  getKillswitchThresholdsForAccount,
} from './accounts'
import { isRecord } from './util/record'
import {
  isVaultMenuConnected,
  type MenuVault,
  readVaultMenu,
  VAULT_LOCAL_ACTION_REFUSAL,
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
    ...(action.description ? { description: action.description } : {}),
    ...(action.group ? { group: action.group } : {}),
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
    const checkQuota = (id?: string): ActionDefinition => ({
      id: 'check',
      label: id ? 'Check this account' : 'Check now',
      group: 'Actions',
      run: async () => {
        // Re-read the routes before polling so a disabled account is not checked.
        const current = await readVaultMenu(vault)
        const ids = [...current.routes].filter(
          (routeId) => !id || routeId === id,
        )
        if (id && ids.length === 0)
          throw new CommandError(
            'unavailable',
            'This vault account cannot be checked right now.',
          )
        for (const routeId of ids) {
          const result = await vault.pollQuota(routeId)
          if (!result.ok)
            throw new CommandError(
              'quota-check-failed',
              `${routeId}: ${result.error ?? 'vault unavailable'}`,
            )
        }
        return `Checked quota for ${ids.length} account${ids.length === 1 ? '' : 's'}.`
      },
    })
    if (slot === 'quota') {
      const quotaText = (
        row: (typeof view.status.accounts)[number],
        form: 'compact' | 'full',
      ) =>
        formatQuota(projectQuota(row.quota, options.quota?.scope), {
          now,
          form,
        })
      return {
        lines: view.status.accounts
          .filter((row) => !view.routes.has(row.routeId))
          .map(
            (row) =>
              `${vaultAccountName(row)} (${row.enabled ? row.state : 'disabled'}): ${quotaText(row, 'compact')}`,
          ),
        items: view.status.accounts
          .filter((row) => view.routes.has(row.routeId))
          .map((row) => ({
            id: row.routeId,
            label: vaultAccountName(row),
            group: 'Accounts',
            status: quotaText(row, 'compact'),
            detail: quotaText(row, 'full'),
            actions: [checkQuota(row.routeId)],
          })),
        actions: view.routes.size > 0 ? [checkQuota()] : [],
      }
    }
    const items = section.items.map((item: MenuItem) => {
      const remote = vaultById.get(item.id)
      const detail =
        remote && slot === 'accounts'
          ? `Vault · ${remote.credentialType === 'oauth' ? 'login' : 'API key'} · ${remote.state} · ${remote.enabled ? 'enabled' : 'declined'}`
          : item.detail
      return {
        id: item.id,
        label: item.label,
        detail,
        group: item.group,
        status:
          remote && slot === 'accounts'
            ? remote.enabled
              ? remote.state
              : 'disabled'
            : item.status,
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
    // Only plugin settings may be forwarded. Account management and roster
    // ordering belong to the vault, not to this host's dormant local pool.
    const actions = section.actions
      .filter(
        (action) =>
          slot === 'limits' || (slot === 'routing' && action.id === 'mode'),
      )
      .map((action) => forwardAction(source, slot, action))
    return {
      lines:
        slot === 'accounts'
          ? [
              `${view.status.accounts.length} vault account${view.status.accounts.length === 1 ? '' : 's'}`,
              `${view.routes.size} can route`,
              VAULT_MODE_LOCAL_NOTE,
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
    routing: undefined,
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
      routing: {
        title: 'Routing',
        build: (invocation) => build('routing', invocation),
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
              const view = await readVaultMenu(vault)
              // Reset credits use local credentials; even a preview can
              // refresh a token or write a quota reading to the local pool.
              if (isVaultMenuConnected(view))
                return { lines: [VAULT_MODE_LOCAL_NOTE] }
              return section.build(invocation)
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
    apply: async (request, invocation) => {
      const menu = await current()
      if (
        menu === connectedMenu &&
        (request.sectionId === 'accounts' ||
          (request.sectionId === 'routing' && request.actionId === 'order') ||
          request.sectionId === 'reset' ||
          (request.sectionId === 'limits' &&
            request.itemId !== undefined &&
            !(await readVaultMenu(vault)).status.accounts.some(
              (row) => row.routeId === request.itemId,
            )))
      )
        return {
          ...(await menu.open(invocation)),
          ok: false,
          code: 'vault-local-action',
          text: VAULT_LOCAL_ACTION_REFUSAL,
        }
      return menu.apply(request, invocation)
    },
  }
}
