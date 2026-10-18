import { spyOn } from 'bun:test'
import * as setup from '../../v2/setup'

// Delay only the first closer. A short child-runner deadline exercises Bun's
// real hook timeout without making the parent suite wait for five seconds.
const install = setup.setupOpenAIAuth
let first = true
spyOn(setup, 'setupOpenAIAuth').mockImplementation(async (...args) => {
  const stop = await install(...args)
  if (!first) return stop
  first = false
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await stop?.()
  }
})
