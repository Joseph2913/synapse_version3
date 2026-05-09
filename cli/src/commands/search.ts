import { callMcp } from '../lib/client.js'
import { loadConfig } from '../lib/config.js'
import { formatSuccess, logError } from '../lib/formatter.js'
import type { Entity } from '../types.js'

interface SearchOptions {
  type?: string
  limit?: number
  sourceId?: string
}

export async function searchEntities(
  query: string,
  options: SearchOptions = {}
): Promise<void> {
  try {
    const config = await loadConfig()
    const limit = options.limit || config.defaultSourceLimit

    const params: Record<string, unknown> = {
      query,
      limit,
    }

    if (options.type) params.entity_type = options.type
    if (options.sourceId) params.source_id = options.sourceId

    const results = (await callMcp('search_entities', params)) as Entity[]

    console.log(
      formatSuccess(results, config.outputFormat)
    )
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

interface SearchSourcesOptions {
  type?: string
  limit?: number
}

export async function searchSources(
  query: string,
  options: SearchSourcesOptions = {}
): Promise<void> {
  try {
    const config = await loadConfig()
    const limit = options.limit || config.defaultSourceLimit

    const params: Record<string, unknown> = {
      query,
      limit,
    }

    if (options.type) params.source_type = options.type

    const results = await callMcp('search_sources', params)

    console.log(
      formatSuccess(results, config.outputFormat)
    )
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
