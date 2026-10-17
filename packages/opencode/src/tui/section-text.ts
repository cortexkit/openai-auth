import type { OpenDialogPayload } from '../rpc/protocol'

type Section = OpenDialogPayload['menu']['sections'][number]

export function factLines(
  facts: Record<string, unknown> | undefined,
): string[] {
  return Object.entries(facts ?? {}).map(
    ([name, value]) =>
      `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  )
}

export function sectionText(section: Section): string {
  return [
    ...section.lines,
    ...factLines(section.facts),
    ...section.items
      .filter((item) => item.actions.length === 0)
      .map((item) =>
        [
          item.group,
          [item.label, item.status].filter(Boolean).join(' · '),
          item.detail,
          ...factLines(item.facts),
        ]
          .filter(Boolean)
          .join('\n'),
      ),
  ]
    .filter(Boolean)
    .join('\n')
}

// DialogSelect counts each category as one row, but measures the title's text.
// Keep section context outside the list so multiline text cannot hide actions.
export function sectionTitle(section: Section): string {
  return [section.title, sectionText(section)].filter(Boolean).join('\n')
}
