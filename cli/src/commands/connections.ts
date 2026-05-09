import { callMcp } from '../lib/client.js'
import { loadConfig } from '../lib/config.js'
import { formatSuccess, logError } from '../lib/formatter.js'

interface ConnectionsOptions {
  hops?: number
}

export async function getConnections(
  label: string,
  options: ConnectionsOptions = {}
): Promise<void> {
  try {
    const config = await loadConfig()
    const hops = Math.min(options.hops || config.defaultConnectionHops, 3)

    const result = await callMcp('get_connections', {
      label,
      hops,
    })

    console.log(
      formatSuccess(result, config.outputFormat)
    )
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
