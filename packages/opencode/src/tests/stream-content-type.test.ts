import { expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'

for (const contentType of [undefined, 'text/plain']) {
  test(`OpenCode1 Responses SDK parses SSE errors with ${contentType ?? 'missing'} content-type`, async () => {
    const message = 'Stream refused key opaque-secret'
    let sends = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect((await request.json()).stream).toBe(true)
        sends++
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify({ type: 'error', sequence_number: 0, code: 'invalid_api_key', message })}\n\n`,
        )
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < bytes.length; index += 7)
                controller.enqueue(bytes.slice(index, index + 7))
              controller.close()
            },
          }),
          { headers: contentType ? { 'content-type': contentType } : {} },
        )
      },
    })
    try {
      const openai = createOpenAI({
        apiKey: 'unused',
        baseURL: `${server.url}v1`,
        fetch: Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await fetch(input, init)
            expect(response.headers.get('content-type')).toBe(
              contentType ?? null,
            )
            return response
          },
          { preconnect() {} },
        ),
      })
      await expect(
        openai.responses('gpt-5.4').doStream({ prompt: [] }),
      ).rejects.toMatchObject({
        message,
        data: { type: 'error', code: 'invalid_api_key', message },
      })
      expect(sends).toBe(1)
    } finally {
      await server.stop(true)
    }
  })
}
