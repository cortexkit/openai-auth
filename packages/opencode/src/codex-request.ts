import {
  type CodexRequestRuntime,
  type CodexSessionMetadata,
  type FrameTurn,
  prepareCodexRequest,
  updateHttpTurnMetadata,
  uuidV7,
} from '@cortexkit/openai-auth-core/internal'

export type { CodexSessionMetadata } from '@cortexkit/openai-auth-core/internal'
// Keep the benchmark's imports working alongside the host's shared builder.
export { prepareCodexRequest, updateHttpTurnMetadata }

/** The last primary turn sent on either transport, without either transport's history. */
export class CodexPrimaryTurns {
  // Key by the live session so forgetting its metadata also forgets the turn.
  readonly #latest = new WeakMap<CodexSessionMetadata, FrameTurn>()

  record(
    session: CodexSessionMetadata,
    {
      turnID,
      turnStartedAt,
    }: Pick<CodexSessionMetadata, keyof FrameTurn> = session,
  ): void {
    if (turnStartedAt !== undefined)
      this.#latest.set(session, { turnID, turnStartedAt })
  }

  forAuxiliary(
    session: CodexSessionMetadata,
    runtime?: CodexRequestRuntime,
  ): CodexSessionMetadata {
    const turn = this.#latest.get(session) ?? {
      turnID: (runtime?.uuid ?? uuidV7)(),
      turnStartedAt: (runtime?.now ?? Date.now)(),
    }
    return {
      threadID: session.threadID,
      windowID: session.windowID,
      ...turn,
      // OpenCode 1 can replay effort changes when it shapes a helper. Let it
      // do so without editing entries the next conversational request needs.
      pinnedEffort: session.pinnedEffort,
      effortUpdates: session.effortUpdates?.map((update) => ({ ...update })),
    }
  }
}
