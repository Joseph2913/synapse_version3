import { promises as fs } from 'fs'
import { callMcp } from '../lib/client.js'
import { loadConfig } from '../lib/config.js'
import { formatSuccess, logError, logSuccess } from '../lib/formatter.js'
import { ValidationError } from '../lib/errors.js'

interface SendOptions {
  fromFile?: string
  repo?: string
  branch?: string
  guidance?: string
}

export async function send(
  title: string,
  content: string | undefined,
  options: SendOptions = {}
): Promise<void> {
  try {
    const config = await loadConfig()

    // Determine content source
    let finalContent = content

    if (options.fromFile) {
      try {
        finalContent = await fs.readFile(options.fromFile, 'utf-8')
      } catch (error) {
        throw new ValidationError(
          `Failed to read file ${options.fromFile}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    if (!finalContent || !finalContent.trim()) {
      throw new ValidationError('Content cannot be empty')
    }

    const params: Record<string, unknown> = {
      title: title || 'Unnamed',
      content: finalContent,
    }

    if (options.repo) params.repo = options.repo
    if (options.branch) params.branch = options.branch
    if (options.guidance) params.guidance = options.guidance

    const result = await callMcp('send_to_synapse', params)

    console.log(
      formatSuccess(result, config.outputFormat)
    )
    logSuccess('Content sent to Synapse graph!')
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
