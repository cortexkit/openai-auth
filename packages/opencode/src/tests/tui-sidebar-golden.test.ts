import { expect, test } from 'bun:test'
import { join } from 'node:path'

for (const mode of ['expanded', 'collapsed']) {
  test(`sidebar golden buffers: ${mode} on OpenCode 1 and 2`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--conditions=browser',
        '--preload',
        '@opentui/solid/runtime-plugin-support',
        'src/tests/fixtures/sidebar-golden-render.ts',
        mode,
      ],
      {
        cwd: join(import.meta.dir, '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(stdout).toContain('sidebar-golden-render passed')
  }, 30_000)
}
