import chalk from 'chalk'
import { table } from 'table'
import type { CliResponse } from '../types.js'

export type OutputFormat = 'json' | 'table' | 'text'

export function formatOutput<T>(
  data: T,
  format: OutputFormat = 'json'
): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2)
  }

  if (format === 'table' && Array.isArray(data)) {
    return formatAsTable(data as Record<string, unknown>[])
  }

  if (format === 'text') {
    return formatAsText(data)
  }

  return JSON.stringify(data, null, 2)
}

function formatAsTable(items: Record<string, unknown>[]): string {
  if (items.length === 0) {
    return chalk.gray('No results found.')
  }

  // Get all keys from first item
  const keys = Object.keys(items[0])
  const headers = keys.map(k => chalk.bold(k))
  const rows = items.map(item =>
    keys.map(k => {
      const value = item[k]
      if (value === null || value === undefined) return ''
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    })
  )

  return table([headers, ...rows], {
    border: {
      topBody: '─',
      topJoin: '┬',
      topLeft: '┌',
      topRight: '┐',
      bottomBody: '─',
      bottomJoin: '┴',
      bottomLeft: '└',
      bottomRight: '┘',
      bodyLeft: '│',
      bodyRight: '│',
      bodyJoin: '│',
      joinBody: '─',
      joinLeft: '├',
      joinRight: '┤',
      joinJoin: '┼',
    },
  })
}

function formatAsText(data: unknown): string {
  if (Array.isArray(data)) {
    return data
      .map(item => {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          const label = obj.label || obj.title || String(item)
          const type = obj.entity_type || obj.source_type || obj.type
          const desc =
            obj.description ||
            obj.content?.toString().substring(0, 80) ||
            ''

          let line = `• ${chalk.bold(String(label))}`
          if (type) line += ` (${chalk.dim(String(type))})`
          if (desc) line += ` — ${chalk.gray(desc)}`
          return line
        }
        return `• ${String(item)}`
      })
      .join('\n')
  }

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>
    const lines: string[] = []

    for (const [key, value] of Object.entries(obj)) {
      const label = chalk.bold(formatKey(key))
      if (Array.isArray(value)) {
        lines.push(`${label}:`)
        value.forEach(v => {
          lines.push(`  • ${v}`)
        })
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${label}: ${JSON.stringify(value)}`)
      } else {
        lines.push(`${label}: ${value}`)
      }
    }

    return lines.join('\n')
  }

  return String(data)
}

function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, str => str.toUpperCase())
}

export function formatSuccess<T>(data: T, format: OutputFormat = 'json'): string {
  const response: CliResponse<T> = {
    status: 'ok',
    data,
  }
  return formatOutput(response, format)
}

export function formatError(error: string, format: OutputFormat = 'json'): string {
  const response: CliResponse<null> = {
    status: 'error',
    error,
  }
  return formatOutput(response, format)
}

export function log(message: string): void {
  console.log(message)
}

export function logError(message: string): void {
  console.error(chalk.red('Error:'), message)
}

export function logSuccess(message: string): void {
  console.log(chalk.green('✓'), message)
}

export function logInfo(message: string): void {
  console.log(chalk.blue('ℹ'), message)
}
