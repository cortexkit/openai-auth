#!/usr/bin/env node
import { runSetup } from '@cortexkit/common-auth/setup'
import packageInfo from '../package.json'
import { prepareRuntimeLayout } from './core/runtime-layout'
import { createSetupPlugin } from './setup'

if (process.argv[2] !== 'setup') {
  console.log('Usage: opencode-openai-auth setup [options]')
} else {
  try {
    // Setup reads and writes OpenCode's vault enrollment: settle where it
    // lives first, the same way a plugin start does.
    await prepareRuntimeLayout({ version: packageInfo.version })
    await runSetup(createSetupPlugin(), process.argv.slice(3))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
