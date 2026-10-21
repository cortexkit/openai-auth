import { expect, test } from 'bun:test'
import { join } from 'node:path'

for (const trigger of ['startup', 'interval']) {
  test(`the ${trigger} vault quota poll contains an expired roster lease and warns once`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures/roster-write-rejection.ts'),
        trigger,
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 8_000 },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
    expect(result.expired).toMatchObject({
      realOwnershipError: true,
      sameOwner: true,
      observedExpiresAt: 0,
      name: 'claustrum-roster-write',
    })
    if (result.unhandled.length)
      throw new Error('background roster quota poll leaked LockOwnershipError')
    expect(result.warnings).toHaveLength(1)
    // The poll queues its reading; the shared roster writer publishes it a
    // moment later and, on the lost lease, warns once and keeps the reading
    // to retry.
    expect(result.warnings[0]).toContain(
      'vault quota publication delayed; retrying',
    )
    expect(result.warnings[0]).toContain('Lost claustrum-roster-write lock')
    expect(result.recovered).toBe(true)
    expect(result.declineRejected).toBe(true)
  }, 10_000)

  test(`the ${trigger} vault quota poll contains its own rejection and warns once`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures/roster-write-rejection.ts'),
        trigger,
        'poll-rejects',
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 8_000 },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
    if (result.unhandled.length)
      throw new Error('background vault quota poll leaked its rejection')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('vault background quota poll failed')
    expect(result.warnings[0]).toContain('injected quota poll failure')
    expect(result.recovered).toBe(true)
  }, 10_000)
}
