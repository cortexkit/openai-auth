// Each package's tests need that package's own preload (its bunfig.toml), which
// floors every path variable so no test reaches the operator's real files.
// Bun reads bunfig.toml only from the folder it runs in, so a test run from the
// repository root would load no preload at all. Refuse it instead.
throw new Error(
  'Run tests from their package folder (cd packages/<name> && bun test ...), or use `bun run test` or scripts/gate.sh. From the repository root no test preload loads.',
)
