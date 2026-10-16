#!/usr/bin/env node
import { runSetup } from '@cortexkit/common-auth/setup'
import { createSetupPlugin } from './setup'

if (process.argv[2] !== 'setup') {
  console.log('Usage: opencode-openai-auth setup [options]')
} else {
  try {
    await runSetup(createSetupPlugin(), process.argv.slice(3))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
