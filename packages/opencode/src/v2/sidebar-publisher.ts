import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { StickyPin } from '@cortexkit/common-auth/routing'
import {
  type AccountPaths,
  loadAccountSettings,
  loadAccounts,
  type OpenAiVault,
} from '@cortexkit/openai-auth-core/internal'
import type { PoolAccountSource } from '../core/pool-account-source'
import {
  buildPoolSidebarMachineState,
  buildVaultSidebarMachineState,
} from '../core/pool-sidebar'
import { createLogger } from '../logger'
import {
  getSidebarStateFile,
  persistSidebarStickyAssignment,
  removeSidebarActiveRouting,
  setSidebarMachineState,
  upsertSidebarActiveRouting,
} from '../sidebar-state'
import type { SessionPins } from './pins'

interface Producer {
  paths: AccountPaths
  source: PoolAccountSource
  pins: SessionPins
  vault: OpenAiVault
}

function stamp(paths: readonly string[]): string {
  return paths
    .map((path) => {
      try {
        const stat = statSync(path)
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      } catch {
        return '?'
      }
    })
    .join('|')
}

function enrollmentStamp(producer: Producer): string {
  return stamp([producer.vault.paths.tokenPath, producer.vault.paths.statePath])
}

function inputStamp(producer: Producer): string {
  return (
    stamp([
      producer.paths.configPath,
      producer.paths.statePath,
      producer.vault.paths.rosterPath,
    ]) + enrollmentStamp(producer)
  )
}

type RoutingChange = {
  sessionId: string
  accountId?: string
  route?: string
  pin?: StickyPin
}

class SidebarPublisher {
  private readonly producers = new Set<Producer>()
  private readonly subscriptions = new Map<
    SessionPins,
    { producers: Set<Producer>; stop: () => void }
  >()
  private readonly observations = new Map<
    Producer,
    { stamp: string; roster: unknown }
  >()
  private chain = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly file: string,
    private readonly observationIntervalMs: number,
  ) {}

  add(producer: Producer): () => void {
    this.producers.add(producer)
    this.observations.set(producer, {
      stamp: inputStamp(producer),
      roster: producer.vault.snapshot(),
    })
    const unsubscribe = producer.source.subscribe(() => {
      void this.publish(producer)
    })
    let subscription = this.subscriptions.get(producer.pins)
    if (!subscription) {
      const producers = new Set<Producer>()
      subscription = {
        producers,
        stop: producer.pins.subscribe((sessionId, pin) => {
          const owner = producers.values().next().value
          if (owner)
            void this.publish(owner, {
              sessionId,
              pin,
              accountId: pin?.accountId,
              route: 'sticky-balanced',
            })
        }),
      }
      this.subscriptions.set(producer.pins, subscription)
    }
    subscription.producers.add(producer)
    // Observe persisted settings/enrollment and the vault's cached roster only.
    // Publication must never call a quota poll, roster discovery or token refresh.
    this.timer ??= setInterval(() => {
      for (const owner of this.producers) {
        const next = {
          stamp: inputStamp(owner),
          roster: owner.vault.snapshot(),
        }
        const previous = this.observations.get(owner)
        if (
          next.stamp !== previous?.stamp ||
          next.roster !== previous?.roster
        ) {
          this.observations.set(owner, next)
          void this.publish(owner)
        }
      }
    }, this.observationIntervalMs)
    this.timer.unref?.()
    return () => {
      unsubscribe()
      this.producers.delete(producer)
      this.observations.delete(producer)
      subscription.producers.delete(producer)
      if (!subscription.producers.size) {
        subscription.stop()
        this.subscriptions.delete(producer.pins)
      }
      if (!this.producers.size) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }

  publish(producer: Producer, routing?: RoutingChange): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        if (!this.producers.has(producer)) return
        const authority = await producer.vault.authority()
        const vaultMode = authority !== 'local'
        const authorityStamp = enrollmentStamp(producer)
        const canWrite = () =>
          this.producers.has(producer) &&
          producer.vault.enrolled() === vaultMode &&
          enrollmentStamp(producer) === authorityStamp
        const store = await (vaultMode
          ? loadAccountSettings(producer.paths)
          : loadAccounts(producer.paths))
        const machine = vaultMode
          ? buildVaultSidebarMachineState(
              producer.vault.snapshot()?.rows ?? [],
              new Set(producer.vault.routes().map((route) => route.id)),
              store,
              Date.now(),
            )
          : buildPoolSidebarMachineState(
              (await producer.source.sidebarView()).rows,
              store,
              Date.now(),
            )
        await setSidebarMachineState(machine, this.file, { canWrite })
        if (!canWrite() || !routing) return
        const accounts = machine.vaultAccounts ?? machine.fallbacks
        if (routing.accountId === undefined) {
          // Removing one session's active route also removes its projected pin.
          await removeSidebarActiveRouting(
            routing.sessionId,
            accounts,
            this.file,
            { canWrite },
          )
          return
        }
        if (routing.pin) {
          const now = Date.now()
          await persistSidebarStickyAssignment(
            {
              sessionId: routing.sessionId,
              assignment: {
                accountId: routing.pin.accountId,
                wireAccountId: routing.pin.wireIdentity,
                inputBytes: routing.pin.inputBytes ?? 0,
                quotaCheckedAt: routing.pin.quotaCheckedAt,
                assignedAt: now,
                lastSeenAt: now,
              },
              validPinnedAccountIds: [
                ...(vaultMode ? [] : ['main']),
                ...accounts.filter((row) => row.enabled).map((row) => row.id),
              ],
            },
            this.file,
          )
        }
        await upsertSidebarActiveRouting(
          {
            sessionId: routing.sessionId,
            activeId: routing.accountId,
            route: routing.route ?? machine.route,
            updatedAt: Date.now(),
          },
          accounts,
          this.file,
          { canWrite },
        )
      })
      .catch(() => {
        // File writers report I/O failures; do not log account snapshots or credentials.
        createLogger('opencode2').warn('sidebar publication failed')
      })
    return this.chain
  }

  settled(): Promise<void> {
    return this.chain
  }
  get empty(): boolean {
    return this.producers.size === 0
  }
}

// The process registry makes separately loaded server bundles and project setups
// share one publication queue and file observer for each sidebar output path.
const registryKey = Symbol.for(
  '@cortexkit/openai-auth/opencode2-sidebar-publishers',
)
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, SidebarPublisher>
}
const publishers =
  processState[registryKey] ?? new Map<string, SidebarPublisher>()
processState[registryKey] = publishers

export function acquireSidebarPublisher(
  producer: Producer,
  file = getSidebarStateFile(),
  observationIntervalMs = 2_000,
) {
  const key = resolve(file)
  let publisher = publishers.get(key)
  if (!publisher) {
    publisher = new SidebarPublisher(key, observationIntervalMs)
    publishers.set(key, publisher)
  }
  const owner = publisher
  const stop = owner.add(producer)
  let released = false
  for (const [sessionId, pin] of producer.pins.snapshot())
    void owner.publish(producer, {
      sessionId,
      pin,
      accountId: pin.accountId,
      route: 'sticky-balanced',
    })
  return {
    publish: () => owner.publish(producer),
    route: (sessionId: string, accountId: string, route: string) => {
      void owner.publish(producer, { sessionId, accountId, route })
    },
    async release() {
      if (released) return
      released = true
      stop()
      await owner.settled()
      // Other project setups still using this file keep its queue and timer alive.
      if (owner.empty && publishers.get(key) === owner) publishers.delete(key)
    },
  }
}
