// The OpenCode 2 entry (`@cortexkit/opencode-openai-auth/server`). The
// package root stays the OpenCode 1 plugin; see `setup.ts` for what this one
// wires.

import { createOpenAIAuthPlugin } from './setup'

export type { OpenAIAuthV2Options } from './setup'
export { createOpenAIAuthPlugin, OPENAI_AUTH_PLUGIN_ID } from './setup'

export default createOpenAIAuthPlugin()
