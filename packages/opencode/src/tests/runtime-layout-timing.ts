import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type {
  __setRuntimeLayoutLockObserverForTest,
  RuntimeLayoutOptions,
} from '../core/runtime-layout'

type LockEvent = Parameters<
  NonNullable<Parameters<typeof __setRuntimeLayoutLockObserverForTest>[0]>
>[0]

/** Opt-in diagnostics; no filesystem scans run inside a measured prepare. */
export class RuntimeLayoutTiming {
  private started = performance.now()
  private caseNumber = 0
  private prepareNumber = 0
  private root = ''
  private label: string | undefined
  private roots = new Set<string>()
  private heldLeases = 0
  private renewals = new Set<string>()
  private lockStarts = new Map<string, number>()

  beginCase(root: string) {
    this.root = root
    this.label = undefined
    this.caseNumber++
    this.prepareNumber = 0
    this.roots.add(root)
    this.write({ event: 'case-start', root })
  }

  labelCase(label: string) {
    this.label = label
    this.write({ event: 'case-label' })
  }

  observeLock = (event: LockEvent) => {
    this.heldLeases = event.heldLeases
    const key = `${event.name}\0${event.path}`
    if (event.phase === 'renewal-scheduled') this.renewals.add(key)
    if (event.phase === 'renewal-cancelled') this.renewals.delete(key)
    const operation = event.phase.split('-')[0]
    const operationKey = `${operation}\0${key}`
    const now = performance.now()
    if (event.phase.endsWith('-start')) this.lockStarts.set(operationKey, now)
    const started = this.lockStarts.get(operationKey)
    const durationMs =
      event.phase.endsWith('-end') && started !== undefined
        ? this.ms(now - started)
        : undefined
    if (event.phase.endsWith('-end')) this.lockStarts.delete(operationKey)
    this.write({
      ...event,
      event: 'lock',
      path: relative(this.root, event.path),
      durationMs,
      renewalSchedules: this.renewals.size,
    })
  }

  prepare(options: Partial<RuntimeLayoutOptions>) {
    const prepare = ++this.prepareNumber
    const started = performance.now()
    let previous = started
    const steps: {
      step: string
      elapsedMs: number
      sincePreviousMs: number
    }[] = []
    const point = (step: string) => {
      const now = performance.now()
      steps.push({
        step,
        elapsedMs: this.ms(now - started),
        sincePreviousMs: this.ms(now - previous),
      })
      previous = now
    }
    this.write({ event: 'prepare-start', prepare })
    return {
      steps: {
        afterCopy: () => {
          point('after-copy')
          return options.steps?.afterCopy?.()
        },
        afterMarker: () => {
          point('after-marker')
          return options.steps?.afterMarker?.()
        },
        beforeRemove: (path: string) => {
          point(`before-remove:${relative(this.root, path)}`)
          return options.steps?.beforeRemove?.(path)
        },
      },
      finish: (outcome: string) => {
        point('settled')
        this.write({
          event: 'prepare-end',
          prepare,
          outcome,
          durationMs: this.ms(performance.now() - started),
          steps,
        })
      },
    }
  }

  snapshot(event: string, pendingPrepares: number) {
    const scanStarted = performance.now()
    const roots = [...this.roots].map((root) => ({
      root,
      ...this.countFiles(root),
    }))
    for (const root of roots) {
      if (!root.exists) this.roots.delete(root.root)
    }
    this.write({
      event,
      pendingPrepares,
      heldLeases: this.heldLeases,
      renewalSchedules: this.renewals.size,
      // Bun 1.3.14 reports no active resources even for a known live timer.
      pendingTimers: 'unavailable in Bun; renewal schedules counted separately',
      roots,
      scanMs: this.ms(performance.now() - scanStarted),
    })
  }

  private countFiles(root: string) {
    let files = 0
    let directories = 0
    let links = 0
    let scanErrors = 0
    const visit = (path: string) => {
      try {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) links++
          else if (entry.isDirectory()) {
            directories++
            visit(join(path, entry.name))
          } else files++
        }
      } catch {
        scanErrors++
      }
    }
    const exists = existsSync(root)
    if (exists) visit(root)
    return { exists, files, directories, links, scanErrors }
  }

  private ms(value: number) {
    return Math.round(value * 100) / 100
  }

  private write(event: Record<string, unknown>) {
    console.error(
      `[layout-timing] ${JSON.stringify({
        case: this.caseNumber,
        label: this.label,
        atMs: this.ms(performance.now() - this.started),
        ...event,
      })}`,
    )
  }
}
