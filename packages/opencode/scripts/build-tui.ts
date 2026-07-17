import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(pluginRoot, 'src')
const outputRoot = join(sourceRoot, 'tui-compiled')
const shippedSourceFiles = [
  'tui.tsx',
  'tui/command-dialogs.tsx',
  'sidebar-state.ts',
  'core/refresh-file-lock.ts',
  'tui-preferences.ts',
  'logger.ts',
  'rpc/rpc-client.ts',
  'rpc/rpc-dir.ts',
  'rpc/port-file.ts',
  'rpc/protocol.ts',
  'util/open-url.ts',
] as const
const runtimeSpecifiers = new Set([
  '@opentui/core',
  '@opentui/core/testing',
  '@opentui/solid',
  '@opentui/solid/components',
  '@opentui/solid/jsx-runtime',
  '@opentui/solid/jsx-dev-runtime',
  'solid-js',
  'solid-js/store',
])

type TransformSolidSource = (
  code: string,
  options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string | null
  },
) => Promise<string>

type SolidTransformModule = {
  transformSolidSource?: TransformSolidSource
}

function runtimeModuleId(specifier: string): string {
  return `opentui:runtime-module:${encodeURIComponent(specifier)}`
}

function asTransformSolidSource(
  mod: SolidTransformModule,
  from: string,
): TransformSolidSource {
  if (typeof mod.transformSolidSource !== 'function') {
    throw new Error(
      `@opentui/solid transform loaded from ${from} without transformSolidSource`,
    )
  }
  return mod.transformSolidSource
}

async function importTransformModule(
  specifier: string,
): Promise<SolidTransformModule> {
  return (await import(specifier)) as SolidTransformModule
}

async function resolveSolidTransformPath(): Promise<string> {
  const packageJsonSpecifier = '@opentui/solid/package.json'
  const errors: string[] = []

  try {
    const packageJsonUrl = import.meta.resolve(packageJsonSpecifier)
    return join(
      dirname(fileURLToPath(packageJsonUrl)),
      'scripts/solid-transform.js',
    )
  } catch (error) {
    errors.push(
      `import.meta.resolve: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    const require = createRequire(import.meta.url)
    return join(
      dirname(require.resolve(packageJsonSpecifier)),
      'scripts/solid-transform.js',
    )
  } catch (error) {
    errors.push(
      `require.resolve: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  throw new Error(
    `Unable to resolve @opentui/solid transform (${errors.join('; ')})`,
  )
}

async function loadTransformSolidSource(): Promise<TransformSolidSource> {
  const bareTransformSpecifier = '@opentui/solid/scripts/solid-transform.js'

  try {
    return asTransformSolidSource(
      await importTransformModule(bareTransformSpecifier),
      bareTransformSpecifier,
    )
  } catch {
    const transformPath = await resolveSolidTransformPath()
    return asTransformSolidSource(
      await importTransformModule(pathToFileURL(transformPath).href),
      transformPath,
    )
  }
}

async function compileTsx(
  transformSolidSource: TransformSolidSource,
  sourceFile: string,
  outputFile: string,
): Promise<void> {
  const code = await readFile(sourceFile, 'utf8')
  const compiled = await transformSolidSource(code, {
    filename: sourceFile,
    moduleName: runtimeModuleId('@opentui/solid'),
    resolvePath: (specifier) =>
      runtimeSpecifiers.has(specifier) ? runtimeModuleId(specifier) : null,
  })

  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, compiled)
}

const transformSolidSource = await loadTransformSolidSource()
await rm(outputRoot, { recursive: true, force: true })

for (const relativePath of shippedSourceFiles) {
  const sourceFile = join(sourceRoot, relativePath)
  const outputFile = join(outputRoot, relativePath)
  await mkdir(dirname(outputFile), { recursive: true })

  if (sourceFile.endsWith('.tsx')) {
    // OpenTUI skips its Solid compile-time transform for packages loaded from
    // node_modules. Precompile JSX reactivity while binding all Solid/OpenTUI
    // imports to the host's process-wide virtual runtime registry.
    await compileTsx(transformSolidSource, sourceFile, outputFile)
  } else {
    await copyFile(sourceFile, outputFile)
  }
}

console.log(
  `build-tui: wrote ${shippedSourceFiles.length} file(s) to ${relative(pluginRoot, outputRoot)}`,
)
