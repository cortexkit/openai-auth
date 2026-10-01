// The `./server` entry of `@cortexkit/opencode-openai-auth`, read by both
// hosts:
//
// - OpenCode 2 imports a package plugin's `./server` export and calls
//   `setup(ctx)` (see `setup.ts` for what it wires).
// - OpenCode 1 also prefers a package's `./server` export over its root once
//   one exists (`resolvePackageEntrypoint` in its plugin loader), and calls
//   `server(input)`. So this entry carries the OpenCode 1 plugin too, the same
//   one the package root exports, under the same id.
//
// Each host ignores the other's member.

import openaiAuthV1 from '../index'
import { createOpenAIAuthPlugin, OPENAI_AUTH_PLUGIN_ID } from './setup'

export type { OpenAIAuthV2Options } from './setup'
export { createOpenAIAuthPlugin, OPENAI_AUTH_PLUGIN_ID } from './setup'

const openaiAuthV2 = createOpenAIAuthPlugin()

export default {
  id: OPENAI_AUTH_PLUGIN_ID,
  /** OpenCode 2. */
  setup: openaiAuthV2.setup,
  /** OpenCode 1. */
  server: openaiAuthV1.server,
}
