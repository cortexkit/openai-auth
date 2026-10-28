import type { RuntimeLayout } from './account-paths'

// Capture older generations before account-paths or process-heartbeat creates
// the layout registries. Even an empty vault/RPC registry proves that code
// which knew only the config-folder paths ran in this process.
const key = Symbol.for('@cortexkit/openai-auth/runtime-layout-runs')
const globals = globalThis as typeof globalThis & {
  [key]?: {
    runs?: Map<string, Promise<RuntimeLayout>>
    logged?: Set<string>
    notice?: { text: string; shown: boolean }
    legacyGeneration?: boolean
  }
}
const symbols = globalThis as unknown as Record<symbol, unknown>
const previous = globals[key]
globals[key] ??= {}
const state = globals[key]
state.legacyGeneration ??=
  previous === undefined &&
  symbols[Symbol.for('@cortexkit/openai-auth/runtime-layouts')] === undefined &&
  (symbols[Symbol.for('@cortexkit/openai-auth/opencode-vaults')] !==
    undefined ||
    symbols[Symbol.for('__openaiAuthRpcServers')] !== undefined ||
    '__openaiAuthRpcServers' in globalThis)
state.runs ??= new Map()
state.logged ??= new Set()
export const runtimeProcessState = Object.assign(state, {
  runs: state.runs,
  logged: state.logged,
})

/** An older generation may still write config-folder files until process exit. */
export function hasLegacyRuntimeGeneration(): boolean {
  return runtimeProcessState.legacyGeneration === true
}
