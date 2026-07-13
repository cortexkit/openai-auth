// Prefer the host OpenTUI runtime registry when it exists. OpenTUI 0.4.x
// registers these virtual modules process-wide, allowing the precompiled TUI to
// share the host's single Solid/OpenTUI runtime when loaded from node_modules.
const runtimeProbe = `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`

function isMissingRuntimeRegistry(error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /Cannot find|Could not resolve|Module not found|Unable to resolve/.test(
      message,
    ) && message.includes('opentui:runtime-module:')
  )
}

let mod
try {
  await import(runtimeProbe)
} catch (error) {
  if (!isMissingRuntimeRegistry(error)) {
    console.error('OpenAI Auth TUI runtime registry probe failed', error)
    throw error
  }
  // Older hosts and bare Bun do not provide the virtual registry. Their source
  // loader still applies the Solid transform, so retain the raw TSX fallback.
  mod = await import('../tui.tsx')
}

if (!mod) {
  try {
    mod = await import('../tui-compiled/tui.tsx')
  } catch (error) {
    console.error('OpenAI Auth compiled TUI failed to load', error)
    throw error
  }
}

export default mod.default
