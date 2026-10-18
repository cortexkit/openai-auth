import { FrameMirror } from '../../v2/frame-mirror'

const stringify = JSON.stringify
const parse = JSON.parse
const full = stringify({
  type: 'response.create',
  model: 'gpt-5.5',
  input: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }],
})
const output = Array.from({ length: 50 }, (_, i) =>
  stringify({
    type: 'response.output_item.done',
    item: { type: 'message', role: 'assistant', content: `item-${i}` },
  }),
)
const deltaFrame = stringify({
  type: 'response.output_text.delta',
  delta: 'x'.repeat(256),
})
const median = (samples: number[]) => {
  const value = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  if (value === undefined) throw new Error('benchmark collected no samples')
  return value
}
const results = []
for (const enabled of [true, false]) {
  const mirror = new FrameMirror()
  ;(
    mirror as FrameMirror & { setEnabled?: (value: boolean) => void }
  ).setEnabled?.(enabled)
  mirror.send('ses', full)
  mirror.receive(
    'ses',
    stringify({ type: 'response.completed', response: { id: 'r0' } }),
  )
  const samples: Record<
    'send' | 'created' | 'output' | 'delta' | 'completed',
    number[]
  > = {
    send: [],
    created: [],
    output: [],
    delta: [],
    completed: [],
  }
  let parses = 0,
    serializations = 0,
    serializedChars = 0
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses++
    return parse(...args)
  }) as typeof JSON.parse
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    serializations++
    const result = stringify(...args)
    serializedChars += result?.length ?? 0
    return result
  }) as typeof JSON.stringify
  try {
    for (let cycle = 0; cycle < 12; cycle++) {
      const sent = stringify({
        type: 'response.create',
        previous_response_id: `r${cycle}`,
        input: [],
      })
      const created = stringify({
        type: 'response.created',
        response: { id: `r${cycle + 1}` },
      })
      const completed = stringify({
        type: 'response.completed',
        response: { id: `r${cycle + 1}` },
      })
      let start = performance.now()
      mirror.send('ses', sent)
      samples.send.push(performance.now() - start)
      start = performance.now()
      mirror.receive('ses', created)
      samples.created.push(performance.now() - start)
      start = performance.now()
      for (const frame of output) mirror.receive('ses', frame)
      samples.output.push((performance.now() - start) / output.length)
      start = performance.now()
      for (let i = 0; i < 50; i++) mirror.receive('ses', deltaFrame)
      samples.delta.push((performance.now() - start) / 50)
      start = performance.now()
      mirror.receive('ses', completed)
      samples.completed.push(performance.now() - start)
    }
  } finally {
    JSON.parse = parse
    JSON.stringify = stringify
  }
  results.push({
    enabled,
    headBytes: 2 * 1024 * 1024,
    cycles: 12,
    outputItemsPerCycle: 50,
    medianMicrosecondsPerFrame: Object.fromEntries(
      Object.entries(samples).map(([name, times]) => [
        name,
        median(times.slice(2)) * 1000,
      ]),
    ),
    parses,
    serializations,
    serializedChars,
  })
}
console.log(JSON.stringify({ bun: Bun.version, results }, null, 2))
