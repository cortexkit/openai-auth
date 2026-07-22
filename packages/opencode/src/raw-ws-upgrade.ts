import { isRecord } from './util/record'

export function rejectedUpgradeStatus(statusLine: string): number | undefined {
  const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1])
  return Number.isFinite(status) ? status : undefined
}

export function rejectedUpgradeEvent(
  buffer: Uint8Array,
  headerEnd: number,
  finalizePartial = false,
): Record<string, unknown> | undefined {
  const headerText = Buffer.from(buffer.slice(0, headerEnd)).toString('latin1')
  const lines = headerText.split('\r\n')
  const statusLine = lines[0] ?? ''
  const status = rejectedUpgradeStatus(statusLine)
  if (status === undefined || status === 101) return undefined

  const headers = Object.fromEntries(
    lines.slice(1).flatMap((line) => {
      const separator = line.indexOf(':')
      return separator === -1
        ? []
        : [
            [
              line.slice(0, separator).trim().toLowerCase(),
              line.slice(separator + 1).trim(),
            ],
          ]
    }),
  )
  const bodyBytes = buffer.slice(headerEnd + 4)
  const contentLengthHeader = headers['content-length']
  const contentLength = Number(contentLengthHeader)
  if (
    !finalizePartial &&
    (contentLengthHeader === undefined ||
      (Number.isFinite(contentLength) && bodyBytes.length < contentLength))
  ) {
    return undefined
  }

  const body = Buffer.from(bodyBytes).toString('utf8')
  const parsed = (() => {
    try {
      const value = JSON.parse(body)
      return isRecord(value) ? value : undefined
    } catch {
      return undefined
    }
  })()
  return {
    message: `WS upgrade failed: ${statusLine}`,
    status,
    status_code: status,
    headers,
    body,
    ...(isRecord(parsed?.error) ? { error: parsed.error } : {}),
  }
}
