import { redactStrings } from '../packages/core/src/logger'

const results = []
for (const variant of ['overlapping', 'incomplete'] as const) {
  for (const length of [512, 2_048, 8_192, 32_768, 131_072]) {
    const input =
      variant === 'overlapping'
        ? 'eyJ-'.repeat(length / 4)
        : `eyJ${'a'.repeat(length / 2)}.${'b'.repeat(length / 2)}`
    const samples = []
    for (let trial = -20; trial < 100; trial++) {
      const start = performance.now()
      for (let repetition = 0; repetition < 100; repetition++)
        redactStrings(input)
      if (trial >= 0) samples.push((performance.now() - start) / 100)
    }
    samples.sort((a, b) => a - b)
    results.push({
      variant,
      chars: input.length,
      median_ms: samples[50],
      p95_ms: samples[94],
    })
  }
}
console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      trials: 100,
      calls_per_trial: 100,
      warmups: 20,
      results,
    },
    null,
    2,
  ),
)
