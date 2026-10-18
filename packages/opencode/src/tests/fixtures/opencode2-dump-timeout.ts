import { spyOn } from 'bun:test'
import * as setup from '../../v2/setup'

// Delay only the first closer. A short child-runner deadline exercises Bun's
// real hook timeout without making the parent suite wait for five seconds.
// The closer outlasts the child's 2,000 ms hook timeout by 1.2 s. A drain hook
// has its own 2,000 ms, so the real drain finishes the cleanup in time, while
// a missing drain lets the next file start with 1.2 s of cleanup still
// pending, a window wide enough on any runner rather than ~100 ms.
const install = setup.setupOpenAIAuth
let first = true
spyOn(setup, 'setupOpenAIAuth').mockImplementation(async (...args) => {
  const stop = await install(...args)
  if (!first) return stop
  first = false
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_200))
    await stop?.()
  }
})
