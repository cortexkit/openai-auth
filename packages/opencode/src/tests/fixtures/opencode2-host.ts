// A stand-in for the OpenCode 2 plugin context and a migrated account pool on
// disk, for the OpenCode 2 entry's tests. Hooks run in registration order and
// honour `providerID` scoping the way the host does.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Credential } from '@opencode/plugin'

type Hook = {
  name: string
  callback: (draft: never) => unknown
  providerID: string | undefined
  disposed: boolean
}

export type RegisteredMethod = {
  integrationID: string
  method: { id: string; type: string; label: string }
  authorize: (answer: unknown) => Promise<{
    url: string
    instructions: string
    mode: 'auto' | 'code'
    callback: Promise<Credential.OAuth> | ((code: string) => Promise<unknown>)
  }>
  refresh?: (credential: Credential.OAuth) => Promise<Credential.OAuth>
}

export type FakeModel = {
  id: string
  modelID?: string
  providerID: string
  enabled: boolean
  limit: { context: number; input?: number; output: number }
}

export function fakeOpenCode2Host(
  options: {
    activeCredential?: Credential.Value
    methods?: RegisteredMethod[]
  } = {},
) {
  let activeCredential = options.activeCredential
  const connectionReads = { active: 0, resolve: 0 }
  const hooks: Hook[] = []
  const methods: RegisteredMethod[] = [...(options.methods ?? [])]
  const modelTransforms: Array<(editor: unknown) => void> = []
  const pending: Array<{ type: string; data: unknown }> = []
  let wake: (() => void) | undefined
  const registration = (onDispose: () => void = () => {}) => ({
    dispose: async () => onDispose(),
  })
  const ctx = {
    session: {
      hook: async (
        name: string,
        callback: (draft: never) => unknown,
        hookOptions?: { providerID?: string },
      ) => {
        const hook: Hook = {
          name,
          callback,
          providerID: hookOptions?.providerID,
          disposed: false,
        }
        hooks.push(hook)
        return registration(() => {
          hook.disposed = true
        })
      },
    },
    event: {
      subscribe(subscribeOptions?: { signal?: AbortSignal }) {
        return {
          async *[Symbol.asyncIterator]() {
            while (!subscribeOptions?.signal?.aborted) {
              const next = pending.shift()
              if (next) {
                yield next
                continue
              }
              await new Promise<void>((resolve) => {
                wake = resolve
                subscribeOptions?.signal?.addEventListener(
                  'abort',
                  () => resolve(),
                  { once: true },
                )
              })
            }
          },
        }
      },
    },
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          method: {
            update: (input: RegisteredMethod) => {
              const index = methods.findIndex(
                (entry) =>
                  entry.integrationID === input.integrationID &&
                  entry.method.id === input.method.id,
              )
              if (index >= 0) methods.splice(index, 1)
              methods.push(input)
            },
          },
        })
        return registration()
      },
      connection: {
        active: async () => {
          connectionReads.active++
          return activeCredential ? { id: 'conn_1' } : undefined
        },
        resolve: async () => {
          connectionReads.resolve++
          return activeCredential
        },
        status: async () => {},
      },
    },
    model: {
      transform: async (callback: (editor: unknown) => void) => {
        modelTransforms.push(callback)
        return registration()
      },
    },
  }
  return {
    ctx: ctx as never,
    hooks,
    methods,
    connectionReads,
    /** Simulates a user selecting another connection without restarting the host. */
    setActiveCredential(value: Credential.Value | undefined) {
      activeCredential = value
    },
    getActiveCredential: () => activeCredential,
    /** Refreshes through the registered method the host credential belongs to. */
    async refreshActiveCredential() {
      if (activeCredential?.type !== 'oauth')
        throw new Error('not an OAuth connection')
      const credential = activeCredential
      const method = methods.find(
        (entry) =>
          entry.integrationID === 'openai' &&
          entry.method.id === credential.methodID,
      )
      if (!method?.refresh)
        throw new Error('no refresh handler for active connection')
      activeCredential = await method.refresh(credential)
      return activeCredential
    },
    /** Runs the registered model transforms over `models`, editing them in place. */
    transformModels(models: FakeModel[]) {
      const editor = {
        list: (providerID?: string) =>
          models.filter(
            (model) =>
              providerID === undefined || model.providerID === providerID,
          ),
        update: (
          providerID: string,
          modelID: string,
          update: (model: FakeModel) => void,
        ) => {
          const model = models.find(
            (entry) => entry.providerID === providerID && entry.id === modelID,
          )
          if (model) update(model)
        },
      }
      for (const transform of modelTransforms) transform(editor)
      return models
    },
    /** Delivers a host event to subscribers and lets them process it. */
    async publish(type: string, data: unknown) {
      pending.push({ type, data })
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /** Runs every live hook registered for `name` that applies to the draft's provider. */
    async fire<T extends { model: { providerID: string } }>(
      name: string,
      draft: T,
    ): Promise<T> {
      for (const hook of hooks) {
        if (hook.name !== name || hook.disposed) continue
        if (hook.providerID && hook.providerID !== draft.model.providerID)
          continue
        await hook.callback(draft as never)
      }
      return draft
    },
  }
}

export type RequestKind = 'primary' | 'title' | 'compaction' | 'generate'

/** The scope fields every session hook draft carries. */
export function scope(sessionID = 'ses_1', kind: RequestKind = 'primary') {
  return {
    sessionID,
    agent: 'build',
    model: { providerID: 'openai', id: 'gpt-5.5' },
    kind,
  }
}

const HOUR = 3600_000

/** A pool quota map with one fresh primary reading. */
export function quotaMap(usedPercent: number) {
  const checkedAt = Date.now()
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        checkedAt,
        usedPercent,
        resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        windowMinutes: 300,
      },
    ],
  }
}

export type PoolSeedRow = {
  id: string
  /** The row's ChatGPT account id; `chatgpt-<id>` by default. */
  identity?: string
  /** The bearer the row holds; `<id>-token` by default. */
  access?: string
  usedPercent?: number
}

export type RoutingModeSeed =
  | 'main-first'
  | 'fallback-first'
  | 'sticky-balanced'

export interface PoolFiles {
  dir: string
  configPath: string
  statePath: string
  paths: () => { configPath: string; statePath: string }
  readConfig(): {
    commonAuthPool: {
      rows: Record<
        string,
        { quota?: { limits?: Array<{ usedPercent?: number }> } }
      >
    }
    accounts: Array<{ id: string; accountId?: string; enabled?: boolean }>
    openaiAuthPool?: { migratedAt?: number }
  }
  readState(): {
    accounts: Record<string, { access?: string; refresh?: string }>
  }
}

export function poolFiles(dir = mkdtempSync(join(tmpdir(), 'oai-oc2-'))) {
  const configPath = join(dir, 'openai-auth.json')
  const statePath = join(dir, 'openai-auth-state.json')
  const files: PoolFiles = {
    dir,
    configPath,
    statePath,
    paths: () => ({ configPath, statePath }),
    readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')),
    readState: () => JSON.parse(readFileSync(statePath, 'utf8')),
  }
  return files
}

/** Writes a migrated install: roster, pool entries, credentials in the state file. */
export function seedPool(
  files: PoolFiles,
  mode: RoutingModeSeed,
  rows: PoolSeedRow[],
): void {
  writeFileSync(
    files.configPath,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode },
      refresh: { refreshBeforeExpiryMinutes: 5 },
      accounts: rows.map((row) => ({
        id: row.id,
        type: 'oauth',
        label: row.id,
        enabled: true,
        accountId: row.identity ?? `chatgpt-${row.id}`,
        addedAt: 1,
      })),
      commonAuthPool: {
        schemaVersion: 1,
        rows: Object.fromEntries(
          rows.map((row) => [
            row.id,
            {
              credentialEpoch: 1,
              needsFirstReading: false,
              quota: quotaMap(row.usedPercent ?? 10),
            },
          ]),
        ),
      },
      openaiAuthPool: { migratedAt: Date.now() - 60_000 },
    }),
  )
  writeFileSync(
    files.statePath,
    JSON.stringify({
      version: 1,
      accounts: Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            access: row.access ?? `${row.id}-token`,
            refresh: `${row.id}-refresh`,
            expires: Date.now() + 24 * HOUR,
          },
        ]),
      ),
    }),
  )
}
