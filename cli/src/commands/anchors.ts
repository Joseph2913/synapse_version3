import { callMcp } from '../lib/client.js'
import { loadConfig } from '../lib/config.js'
import { formatSuccess, logError } from '../lib/formatter.js'

export async function listAnchors(): Promise<void> {
  try {
    const config = await loadConfig()

    const result = await callMcp('list_anchors', {})

    console.log(
      formatSuccess(result, config.outputFormat)
    )
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
