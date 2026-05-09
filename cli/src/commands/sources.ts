import { callMcp } from '../lib/client.js'
import { loadConfig } from '../lib/config.js'
import { formatSuccess, logError } from '../lib/formatter.js'

interface SourcesOptions {
  type?: string
  recent?: number
  from?: string
  to?: string
  participant?: string
}

export async function getSources(options: SourcesOptions = {}): Promise<void> {
  try {
    const config = await loadConfig()

    const params: Record<string, unknown> = {
      limit: options.recent || config.defaultSourceLimit,
    }

    if (options.type) params.source_type = options.type
    if (options.from) params.date_from = options.from
    if (options.to) params.date_to = options.to
    if (options.participant) params.participant = options.participant

    const result = await callMcp('get_recent_sources', params)

    console.log(
      formatSuccess(result, config.outputFormat)
    )
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export async function readSource(sourceId: string): Promise<void> {
  try {
    const config = await loadConfig()

    const result = await callMcp('get_source_content', {
      source_id: sourceId,
    })

    console.log(
      formatSuccess(result, config.outputFormat)
    )
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
