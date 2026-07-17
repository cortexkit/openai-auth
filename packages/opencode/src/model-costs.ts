import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const MODELS_CACHE_ENV = 'OPENCODE_OPENAI_AUTH_MODELS_CACHE'
const FETCH_TIMEOUT_MS = 10_000

type CacheCost = { read: number; write: number }

type TierCost = {
  input: number
  output: number
  cache: CacheCost
  tier: { type: 'context'; size: number }
}

export type ModelCost = {
  input: number
  output: number
  cache: CacheCost
  tiers?: TierCost[]
  experimentalOver200K?: {
    input: number
    output: number
    cache: CacheCost
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// Restoring a zero price for a direction the catalog actually charges for
// would silently under-record costs — the exact failure this module exists
// to prevent. So a price block is only accepted when BOTH directions are
// finite numbers; optional cache prices default to zero.
function strictPrices(
  raw: Record<string, unknown>,
): { input: number; output: number; cache: CacheCost } | null {
  const { input, output } = raw
  if (typeof input !== 'number' || !Number.isFinite(input)) return null
  if (typeof output !== 'number' || !Number.isFinite(output)) return null
  return {
    input,
    output,
    cache: {
      read: finiteNumber(raw.cache_read),
      write: finiteNumber(raw.cache_write),
    },
  }
}

export function toSdkCost(raw: unknown): ModelCost | null {
  const source = record(raw)
  if (!source) return null

  const base = strictPrices(source)
  if (!base) return null

  const cost: ModelCost = base
  if (Array.isArray(source.tiers)) {
    // A malformed tier is dropped rather than defaulted: a tier without a
    // real positive size would match every request in the host's tier
    // selection (contextTokens > size), and zero-defaulted tier prices
    // would override the base pricing once the threshold is crossed.
    const tiers: TierCost[] = []
    for (const rawTier of source.tiers) {
      const tier = record(rawTier)
      if (!tier) continue
      const tierRule = record(tier.tier)
      const size = tierRule?.size
      if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0)
        continue
      const prices = strictPrices(tier)
      if (!prices) continue
      tiers.push({
        ...prices,
        tier: { type: 'context', size },
      })
    }
    if (tiers.length > 0) cost.tiers = tiers
  }

  const over200K = record(source.context_over_200k)
  const overPrices = over200K ? strictPrices(over200K) : null
  if (overPrices) cost.experimentalOver200K = overPrices

  return cost
}

function catalogCosts(raw: unknown): Record<string, ModelCost> | null {
  const root = record(raw)
  const openai = record(root?.openai)
  const models = record(openai?.models)
  if (!models) return null

  const costs: Record<string, ModelCost> = {}
  for (const [modelID, rawModel] of Object.entries(models)) {
    const model = record(rawModel)
    const cost = toSdkCost(model?.cost)
    if (cost) costs[modelID] = cost
  }
  return costs
}

function modelsCachePath(): string {
  return (
    process.env[MODELS_CACHE_ENV]?.trim() ||
    join(homedir(), '.cache', 'opencode', 'models.json')
  )
}

async function resolveModelsDevCosts(): Promise<Record<
  string,
  ModelCost
> | null> {
  try {
    const cachedCatalog = catalogCosts(
      JSON.parse(await readFile(modelsCachePath(), 'utf8')),
    )
    if (cachedCatalog) return cachedCatalog
  } catch {}

  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return catalogCosts(await response.json())
  } catch {
    return null
  }
}

let cachedCosts: Promise<Record<string, ModelCost> | null> | undefined

export function loadModelsDevCosts(): Promise<Record<
  string,
  ModelCost
> | null> {
  cachedCosts ??= resolveModelsDevCosts()
  return cachedCosts
}

/** Test-only: drop the memoized catalog so a later load re-reads its source. */
export function resetModelCostsForTest(): void {
  cachedCosts = undefined
}
