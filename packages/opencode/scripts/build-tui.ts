import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(pluginRoot, 'src')
const outputRoot = join(sourceRoot, 'tui-compiled')
// Files under src/ that the TUI entry reaches. Each output variant is flattened
// and its relative imports are rewritten so only generated files are reachable.
const shippedSourceFiles = [
  'tui.tsx',
  'tui/command-dialogs.tsx',
  'sidebar-state.ts',
  'core/account-paths.ts',
  'tui-preferences.ts',
  'logger.ts',
  'rpc/rpc-client.ts',
  'rpc/rpc-dir.ts',
  'rpc/port-file.ts',
  'rpc/protocol.ts',
] as const
const sharedCoreSourceFiles = [
  'paths.ts',
  'refresh-file-lock.ts',
  'util/error.ts',
  'util/open-url.ts',
] as const
const coreSpecifiers = new Set([
  '@cortexkit/openai-auth-core',
  '@cortexkit/openai-auth-core/internal',
])
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

function posixPath(path: string): string {
  return path.replaceAll('\\', '/')
}

function generatedFileName(relativePath: string): string {
  return relativePath.replaceAll('/', '-')
}

const shippedSourceSet = new Set<string>(shippedSourceFiles)

function resolveShippedSource(
  importerRelativePath: string,
  specifier: string,
): string | null {
  const importerDirectory = dirname(join(sourceRoot, importerRelativePath))
  const unresolved = resolve(importerDirectory, specifier)
  const candidates = [unresolved]

  if (specifier.endsWith('.js')) {
    const withoutExtension = unresolved.slice(0, -3)
    candidates.push(`${withoutExtension}.ts`, `${withoutExtension}.tsx`)
  } else if (!specifier.endsWith('.ts') && !specifier.endsWith('.tsx')) {
    candidates.push(`${unresolved}.ts`, `${unresolved}.tsx`)
  }

  const sourceFile = candidates.find((candidate) => existsSync(candidate))
  if (!sourceFile) return null

  const relativePath = posixPath(relative(sourceRoot, sourceFile))
  if (!shippedSourceSet.has(relativePath)) {
    throw new Error(
      `${importerRelativePath} reaches ${relativePath}, which is missing from shippedSourceFiles`,
    )
  }
  return relativePath
}

function relativeImport(fromFile: string, toFile: string): string {
  const specifier = posixPath(relative(dirname(fromFile), toFile))
  return specifier.startsWith('.') ? specifier : `./${specifier}`
}

function rewriteGeneratedImports(
  code: string,
  sourceRelativePath: string,
  outputFile: string,
  variantRoot: string,
): string {
  const relativeImportPattern =
    /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g
  let rewritten = code.replace(
    relativeImportPattern,
    (match, prefix: string, quote: string, specifier: string) => {
      const target = resolveShippedSource(sourceRelativePath, specifier)
      if (!target) return match
      const targetFile = join(variantRoot, generatedFileName(target))
      return `${prefix}${quote}${relativeImport(outputFile, targetFile)}${quote}`
    },
  )

  const sharedInternal = relativeImport(
    outputFile,
    join(outputRoot, 'shared', 'internal.ts'),
  )
  rewritten = rewritten.replace(
    /(['"])(@cortexkit\/openai-auth-core(?:\/internal)?)\1/g,
    (match, quote: string, specifier: string) =>
      coreSpecifiers.has(specifier)
        ? `${quote}${sharedInternal}${quote}`
        : match,
  )
  return rewritten
}

async function writeSharedCore(): Promise<void> {
  const sharedRoot = join(outputRoot, 'shared')
  const coreSourceRoot = join(pluginRoot, '..', 'core', 'src')

  for (const relativePath of sharedCoreSourceFiles) {
    const outputFile = join(sharedRoot, relativePath)
    await mkdir(dirname(outputFile), { recursive: true })
    await writeFile(outputFile, await readFile(join(coreSourceRoot, relativePath)))
  }

  await writeFile(
    join(sharedRoot, 'internal.ts'),
    [
      "export { type AccountPaths, ACCOUNT_FILE_NAME, ACCOUNT_STATE_FILE_NAME, deriveStatePath } from './paths.ts'",
      "export { acquireRefreshFileLock } from './refresh-file-lock.ts'",
      "export { errorMessage } from './util/error.ts'",
      "export { openUrl } from './util/open-url.ts'",
      '',
    ].join('\n'),
  )
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
  code: string,
): Promise<string> {
  return transformSolidSource(code, {
    filename: sourceFile,
    moduleName: runtimeModuleId('@opentui/solid'),
    resolvePath: (specifier) =>
      runtimeSpecifiers.has(specifier) ? runtimeModuleId(specifier) : null,
  })
}

const transformSolidSource = await loadTransformSolidSource()
const rawRoot = join(outputRoot, 'raw')
const runtimeRoot = join(outputRoot, 'runtime')
await rm(outputRoot, { recursive: true, force: true })
await writeSharedCore()

for (const relativePath of shippedSourceFiles) {
  const sourceFile = join(sourceRoot, relativePath)
  const source = await readFile(sourceFile, 'utf8')
  const outputName = generatedFileName(relativePath)
  const rawOutputFile = join(rawRoot, outputName)
  const runtimeOutputFile = join(runtimeRoot, outputName)

  await mkdir(dirname(rawOutputFile), { recursive: true })
  await writeFile(
    rawOutputFile,
    rewriteGeneratedImports(source, relativePath, rawOutputFile, rawRoot),
  )

  // OpenTUI skips its Solid compile-time transform for packages loaded from
  // node_modules. Precompile JSX reactivity while binding all Solid/OpenTUI
  // imports to the host's process-wide virtual runtime registry.
  const runtimeSource = sourceFile.endsWith('.tsx')
    ? await compileTsx(transformSolidSource, sourceFile, source)
    : source
  await mkdir(dirname(runtimeOutputFile), { recursive: true })
  await writeFile(
    runtimeOutputFile,
    rewriteGeneratedImports(
      runtimeSource,
      relativePath,
      runtimeOutputFile,
      runtimeRoot,
    ),
  )
}

console.log(
  `build-tui: wrote raw and runtime variants for ${shippedSourceFiles.length} file(s) to ${relative(pluginRoot, outputRoot)}`,
)
