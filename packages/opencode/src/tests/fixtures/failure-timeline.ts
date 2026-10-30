type Phase = {
  name: string
  atMs: number
  tookMs?: number
}

/** Keep the body and teardown on one clock, without logging successful tests. */
export function failureTimeline(test: string) {
  const started = performance.now()
  const phases: Phase[] = []
  let failure: string | undefined
  let maxEventLoopGapMs = 0

  function start(name: string) {
    const at = performance.now()
    const entry: Phase = { name, atMs: at - started }
    phases.push(entry)
    return () => {
      entry.tookMs ??= performance.now() - at
    }
  }

  function phase<T>(name: string, action: () => T): T {
    const end = start(name)
    try {
      const result = action()
      if (result instanceof Promise) return result.finally(end) as T
      end()
      return result
    } catch (error) {
      end()
      throw error
    }
  }

  function report(reason: string) {
    failure ??= reason
    const elapsedMs = performance.now() - started
    console.error(
      JSON.stringify({
        test,
        failure,
        reason,
        elapsedMs,
        maxEventLoopGapMs,
        phases: phases.map((entry) => ({
          ...entry,
          tookMs: entry.tookMs ?? elapsedMs - entry.atMs,
          pending: entry.tookMs === undefined,
        })),
      }),
    )
  }

  async function run(name: string, action: () => unknown) {
    let lastBeat = performance.now()
    const heartbeat = setInterval(() => {
      const now = performance.now()
      maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastBeat)
      lastBeat = now
    }, 50)
    // Match Bun's body/hook deadline so an unfinished phase is visible even
    // when Bun stops awaiting the callback instead of rejecting its promise.
    const deadline = setTimeout(() => report(`${name} timed out`), 5_000)
    const at = performance.now()
    try {
      await phase(name, action)
    } catch (error) {
      failure ??= `${name}: ${String(error)}`
      throw error
    } finally {
      maxEventLoopGapMs = Math.max(
        maxEventLoopGapMs,
        performance.now() - lastBeat,
      )
      clearInterval(heartbeat)
      clearTimeout(deadline)
      if (performance.now() - at >= 5_000) failure ??= `${name} timed out`
      if (failure) report(`${name} finished`)
    }
  }

  return { phase, start, run }
}

export type FailureTimeline = ReturnType<typeof failureTimeline>
