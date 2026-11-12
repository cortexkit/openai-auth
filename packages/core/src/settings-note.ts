import { readFileSync } from 'node:fs'
import { canonicalSettingsPath } from './settings-install.ts'

const notePrefix = 'Settings moved to '

/** Read only the move note's first line; paths are written without escaping. */
export function settingsNoteTarget(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  if (!firstLine.startsWith(notePrefix) || !firstLine.endsWith('.')) {
    return undefined
  }
  return firstLine.slice(notePrefix.length, -1)
}

export function readSettingsNoteTarget(sourcePath: string): string | undefined {
  try {
    return settingsNoteTarget(
      readFileSync(`${sourcePath}.MOVED_READPLEASE`, 'utf8'),
    )
  } catch {
    return undefined
  }
}

export function settingsNoteNamesTarget(
  sourcePath: string,
  target: string,
): boolean {
  const named = readSettingsNoteTarget(sourcePath)
  return (
    named !== undefined &&
    canonicalSettingsPath(named) === canonicalSettingsPath(target)
  )
}
