import { stripMarkdown } from './stripMarkdown'

export function formatSourceSummary(summary: string | null | undefined): string {
  if (!summary) return ''
  return stripMarkdown(summary)
}
