// Generates the two TUI variants the ./tui entry chooses between, using the
// shared TUI build from @cortexkit/common-auth.
//
//   raw/      source as written, for hosts without the OpenTUI runtime
//             registry; their loader still applies the Solid transform.
//   runtime/  JSX precompiled and every Solid/OpenTUI import bound to the
//             host's process-wide runtime registry, because OpenTUI skips its
//             Solid transform for packages loaded from node_modules.
//
// Each variant is the closure of src/tui.tsx. @cortexkit/common-auth and the
// private core are inlined (copied under shared/), because neither is installed
// with the published plugin. Each variant also gets a copy of the library's TUI
// selector, which src/tui/entry.mjs imports relatively. After building, the
// emitted files are compared with what npm would actually publish.
import { rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertEmittedPublishList,
  buildTui,
} from '@cortexkit/common-auth/tui-build'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(pluginRoot, 'src', 'tui.tsx')
const outputRoot = join(pluginRoot, 'src', 'tui-compiled')
const inline = [
  '@cortexkit/common-auth',
  { name: '@cortexkit/openai-auth-core', root: join(pluginRoot, '..', 'core') },
]

// Start clean so files from an earlier build layout cannot linger.
await rm(outputRoot, { recursive: true, force: true })

const emitted: string[] = []
const externals = new Set<string>()
for (const variant of ['raw', 'runtime'] as const) {
  const destination = join(outputRoot, variant)
  const result = await buildTui(entry, variant, destination, { inline })
  if (result.selector !== 'selector.js') {
    // src/tui/entry.mjs imports the selector by this name.
    throw new Error(`build-tui: unexpected selector name ${result.selector}`)
  }
  emitted.push(...result.emitted.map((file) => `${variant}/${file}`))
  for (const specifier of result.externals) externals.add(specifier)
}

await assertEmittedPublishList(pluginRoot, outputRoot, emitted)

console.log(
  `build-tui: wrote ${emitted.length} file(s) to ${relative(pluginRoot, outputRoot)}; external imports: ${[...externals].sort().join(', ')}`,
)
