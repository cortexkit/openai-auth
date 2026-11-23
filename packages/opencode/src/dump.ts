import { createCodexDumps } from '@cortexkit/openai-auth-core/internal'
import { getSettings, isRequestDumpEnabled } from './config'

export {
  bodySummary,
  DUMP_SCHEMA_KEYS,
  DUMP_SECRET_KEYS,
  DUMP_SESSION_HEADER,
} from '@cortexkit/openai-auth-core/internal'

export const { dumpCodexRequest, dumpDiagnostic, resetDumpStateForTest } =
  createCodexDumps({
    enabled: isRequestDumpEnabled,
    dir: () => getSettings().dumpDir,
    maxBytes: () => getSettings().dumpMaxBytes,
  })
