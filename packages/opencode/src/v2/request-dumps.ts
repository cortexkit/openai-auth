import type { Attempt, AttemptOutcome } from '@cortexkit/common-auth/opencode2'
import { redactCredentialText } from '@cortexkit/openai-auth-core/internal'
import { getSettings } from '../config'
import { dumpCodexRequest } from '../dump'

type DumpInput = Parameters<typeof dumpCodexRequest>[0]

/** Diagnostic snapshots never own the request or its response stream. */
export class RequestDumps {
  private readonly pending = new Map<
    Request,
    { attemptId: string; input: DumpInput }
  >()
  private readonly requests = new Map<string, Request>()
  private readonly writing = new Set<Promise<void>>()

  constructor(private readonly log: { warn(message: string): void }) {}

  private async safely(work: () => Promise<void>) {
    const writing = (async () => {
      try {
        await work()
      } catch {
        // Ordinary write errors are already logged by the dumper. Security errors
        // escape it, so report them here without exposing paths or credentials.
        this.log.warn('request dump failed')
      }
    })()
    this.writing.add(writing)
    try {
      await writing
    } finally {
      this.writing.delete(writing)
    }
  }

  async captureHttp(request: Request, attempt: Attempt) {
    await this.safely(async () => {
      if (!getSettings().dump) return
      const input: DumpInput = {
        sessionID: attempt.sessionID,
        accountId: attempt.accountId,
        transport: 'http',
        phase: 'http',
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        bodyText: await request.clone().text(),
      }
      this.pending.set(request, { attemptId: attempt.attemptId, input })
      this.requests.set(attempt.attemptId, request)
      if (this.pending.size > 512) {
        const oldest = this.pending.keys().next().value
        if (oldest) this.take(oldest)
      }
    })
  }

  private take(request: Request) {
    const entry = this.pending.get(request)
    if (entry) {
      this.pending.delete(request)
      this.requests.delete(entry.attemptId)
    }
    return entry?.input
  }

  async response(request: Request, status: number) {
    // Close before awaiting IO: stream completion or cancellation cannot emit a
    // second record, even while the first write is still pending.
    const input = this.take(request)
    if (input) await this.safely(() => dumpCodexRequest({ ...input, status }))
  }

  async end(attempt: Attempt, outcome: AttemptOutcome) {
    // Error responses can end before rewriteResponse runs. Their status belongs
    // to the response path, not to a no-response error record.
    if (outcome.status !== undefined || !outcome.error) return
    const request = this.requests.get(attempt.attemptId)
    const input = request && this.take(request)
    if (!input) return
    const { reason, message } = outcome.error
    const error = message ? `${reason}: ${message}` : reason
    await this.safely(() =>
      dumpCodexRequest({
        ...input,
        error: redactCredentialText(
          error,
          request?.headers.get('authorization')?.replace(/^Bearer /, ''),
        ),
      }),
    )
  }

  async frame(frame: string, attempt: Attempt) {
    await this.safely(() =>
      dumpCodexRequest({
        sessionID: attempt.sessionID,
        accountId: attempt.accountId,
        transport: 'websocket',
        phase: 'observed',
        bodyText: frame,
      }),
    )
  }

  clear() {
    this.pending.clear()
    this.requests.clear()
  }

  async settle() {
    // The installer starts abandonment callbacks without awaiting their IO.
    // Finish those diagnostics before shutdown releases this location's state.
    await Promise.all(this.writing)
  }
}
