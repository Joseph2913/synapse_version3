import { callMcp } from '../lib/client.js'
import { loadConfig } from '../lib/config.js'
import { formatSuccess, formatError, logError } from '../lib/formatter.js'
import type { RagResponse } from '../types.js'

interface AskOptions {
  limit?: number
  sourcesOnly?: boolean
}

export async function ask(question: string, options: AskOptions = {}): Promise<void> {
  try {
    const config = await loadConfig()
    const limit = options.limit || config.defaultSourceLimit

    const result = (await callMcp('ask_synapse', {
      query: question,
      max_results: limit,
    })) as RagResponse

    if (options.sourcesOnly) {
      // Return only sources in requested format
      const sources = result.sources.map(s => ({
        title: s.title,
        type: s.source_type,
        relevance: `${Math.round(s.relevance * 100)}%`,
      }))

      console.log(
        formatSuccess(sources, config.outputFormat)
      )
    } else {
      // Return full RAG response
      console.log(
        formatSuccess(result, config.outputFormat)
      )
    }
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
