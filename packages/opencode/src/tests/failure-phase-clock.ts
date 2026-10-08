type Phase = { name: string; offsetMs: number; durationMs?: number }

/** Print phase durations and unfinished steps only on failures or overruns. */
export function createFailurePhaseClock(
  details?: () => Record<string, unknown>,
) {
  let current:
    | {
        start(name: string): () => void
        step<T>(name: string, run: () => T): T
        report(reason: string): void
      }
    | undefined

  function phase<T>(name: string, run: () => T): T {
    return current ? current.step(name, run) : run()
  }

  async function run(name: string, body: () => Promise<void>) {
    const started = performance.now()
    const phases: Phase[] = []
    const clock = {
      start(step: string) {
        const start = performance.now()
        const entry: Phase = { name: step, offsetMs: start - started }
        phases.push(entry)
        return () => {
          entry.durationMs ??= performance.now() - start
        }
      },
      step<T>(step: string, action: () => T): T {
        const finish = clock.start(step)
        try {
          const result = action()
          if (result instanceof Promise) return result.finally(finish) as T
          finish()
          return result
        } catch (error) {
          finish()
          throw error
        }
      },
      report(reason: string) {
        const elapsedMs = performance.now() - started
        console.error(
          JSON.stringify({
            test: name,
            reason,
            elapsedMs,
            ...details?.(),
            phases: phases.map((entry) => ({
              ...entry,
              durationMs: entry.durationMs ?? elapsedMs - entry.offsetMs,
              inFlight: entry.durationMs === undefined,
            })),
          }),
        )
      },
    }
    current = clock
    const deadline = setTimeout(
      () => clock.report('body exceeded 5000 ms'),
      5_000,
    )
    try {
      await body()
      if (performance.now() - started >= 5_000)
        clock.report('slow body completed')
    } catch (error) {
      clock.report('body failed')
      throw error
    } finally {
      clearTimeout(deadline)
      if (current === clock) current = undefined
    }
  }

  return {
    run,
    phase,
    start: (name: string) => current?.start(name) ?? (() => {}),
    report: (reason: string) => current?.report(reason),
  }
}
