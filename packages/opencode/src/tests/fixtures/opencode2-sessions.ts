// One OpenCode 2 server process for the session-file tests. It sets up the
// plugin in one or more locations over a shared pool and config directory,
// runs the steps it is given, and prints what each request carried. Exiting
// is the restart boundary the parent test exercises.

import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { opencode1HostSlot } from '../../v2/host-slot'
import { setupOpenAIAuth } from '../../v2/setup'
import { fakeOpenCode2Host, poolFiles, scope } from './opencode2-host'

export type SessionStep =
  | { op: 'send'; location: number; session: string }
  | { op: 'reload'; location: number }
  | { op: 'delete'; location: number; session: string }

export interface SentRequest {
  session: string
  threadID: string | null
  sessionHeader: string | null
  cacheKey: unknown
  turnID: string
}

const [root, locationCount, stepsText] = process.argv.slice(2)
if (!root || !locationCount || !stepsText)
  throw new Error('usage: opencode2-sessions <root> <locations> <steps>')
const files = poolFiles(root)
const offline: typeof fetch = Object.assign(
  async () => {
    throw new Error('offline sessions fixture')
  },
  { preconnect() {} },
) as typeof fetch
globalThis.fetch = offline

async function startLocation(index: number) {
  const host = fakeOpenCode2Host()
  const stop = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    sidebarStateFile: join(
      root as string,
      `sidebar-${process.pid}-${index}.json`,
    ),
    slot: opencode1HostSlot(join(root as string, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
  })
  return { host, stop }
}

const locations = []
for (let index = 0; index < Number(locationCount); index++)
  locations.push(await startLocation(index))

const sent: SentRequest[] = []
for (const step of JSON.parse(stepsText) as SessionStep[]) {
  const location = locations[step.location]
  if (!location) throw new Error(`no location ${step.location}`)
  if (step.op === 'reload') {
    await location.stop?.()
    locations[step.location] = await startLocation(step.location)
  } else if (step.op === 'delete') {
    await location.host.publish('session.deleted', { sessionID: step.session })
  } else {
    const draft = {
      ...scope(step.session),
      request: new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${placeholderSecret('openai')}`,
          'content-type': 'application/json',
          'session-id': step.session,
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          ],
        }),
      }),
    }
    await location.host.fire('http.request', draft)
    const headers = draft.request.headers
    sent.push({
      session: step.session,
      threadID: headers.get('thread-id'),
      sessionHeader: headers.get('session-id'),
      cacheKey: (await draft.request.json()).prompt_cache_key,
      turnID: JSON.parse(headers.get('x-codex-turn-metadata') ?? '{}').turn_id,
    })
  }
}
// Stopping a location waits for its pending session-file saves.
for (const location of locations) await location.stop?.()
console.log(JSON.stringify(sent))
process.exit(0)
