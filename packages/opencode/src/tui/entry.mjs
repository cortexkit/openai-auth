// Prefer the host OpenTUI runtime registry when it exists. OpenTUI 0.4.x
// registers these virtual modules process-wide, allowing the precompiled TUI to
// share the host's single Solid/OpenTUI runtime when loaded from node_modules.
// Older hosts and bare Bun do not provide the virtual registry. Their source
// loader still applies the Solid transform, so the raw TSX variant is the
// fallback. The selector that makes this choice is emitted by the TUI build
// next to each variant, so it resolves inside the published package.
import { loadTui } from '../tui-compiled/runtime/selector.js'

const rawEntry = new URL('../tui-compiled/raw/tui.tsx', import.meta.url).href
const runtimeEntry = new URL('../tui-compiled/runtime/tui.js', import.meta.url)
  .href

// Which import the selector ran last: the registry probe, or one variant.
let stage = 'probe'
let mod
try {
  mod = await loadTui({
    rawEntry,
    runtimeEntry,
    importModule: (specifier) => {
      if (specifier === rawEntry) stage = 'raw'
      else if (specifier === runtimeEntry) stage = 'runtime'
      return import(specifier)
    },
  })
} catch (error) {
  // A probe failure other than a missing registry, and a failed runtime
  // variant, are reported before rethrowing; a raw-variant failure propagates
  // as it is.
  if (stage === 'probe')
    console.error('OpenAI Auth TUI runtime registry probe failed', error)
  else if (stage === 'runtime')
    console.error('OpenAI Auth compiled TUI failed to load', error)
  throw error
}

export default mod
