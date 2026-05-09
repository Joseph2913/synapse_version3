import prompts from 'prompts'
import {
  loadConfig,
  saveConfig,
  maskApiKey,
  ensureConfigDir,
} from '../lib/config.js'
import { log, logError, logSuccess, logInfo } from '../lib/formatter.js'
import { ConfigError } from '../lib/errors.js'

export async function init(): Promise<void> {
  try {
    let existingConfig = null
    try {
      existingConfig = await loadConfig()
    } catch {
      // Config doesn't exist yet
    }

    const response = await prompts([
      {
        type: 'text',
        name: 'apiUrl',
        message: 'MCP API URL',
        initial: existingConfig?.apiUrl || 'http://localhost:3001/api/mcp',
      },
      {
        type: 'password',
        name: 'apiKey',
        message: 'API Key (sk-syn-...)',
        validate: (value: string) => {
          if (!value.startsWith('sk-syn-')) {
            return 'API key must start with sk-syn-'
          }
          if (value.length !== 47) {
            return 'API key must be 47 characters long'
          }
          return true
        },
      },
      {
        type: 'select',
        name: 'outputFormat',
        message: 'Default output format',
        choices: [
          { title: 'JSON', value: 'json' },
          { title: 'Table', value: 'table' },
          { title: 'Text', value: 'text' },
        ],
        initial: 0,
      },
    ])

    if (!response.apiUrl || !response.apiKey) {
      throw new ConfigError('Setup cancelled.')
    }

    const apiKeyPrefix = response.apiKey.substring(0, 8)

    await saveConfig({
      apiUrl: response.apiUrl,
      apiKey: response.apiKey,
      apiKeyPrefix,
      outputFormat: response.outputFormat || 'json',
      defaultSourceLimit: 10,
      defaultConnectionHops: 2,
    })

    logSuccess('Configuration saved!')
    logInfo(`API URL: ${response.apiUrl}`)
    logInfo(`API Key: ${maskApiKey(response.apiKey)}`)
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export async function show(): Promise<void> {
  try {
    const config = await loadConfig()
    log('')
    log('Current Synapse Configuration:')
    log('')
    log(`  API URL:              ${config.apiUrl}`)
    log(`  API Key:              ${maskApiKey(config.apiKey)}`)
    log(`  Output Format:        ${config.outputFormat}`)
    log(`  Default Source Limit: ${config.defaultSourceLimit}`)
    log(`  Default Hops:         ${config.defaultConnectionHops}`)
    log('')
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export async function set(key: string, value: string): Promise<void> {
  try {
    const validKeys = [
      'apiUrl',
      'apiKey',
      'outputFormat',
      'defaultSourceLimit',
      'defaultConnectionHops',
    ]

    if (!validKeys.includes(key)) {
      throw new ConfigError(`Invalid config key: ${key}. Valid keys: ${validKeys.join(', ')}`)
    }

    if (key === 'apiKey' && !value.startsWith('sk-syn-')) {
      throw new ConfigError('API key must start with sk-syn-')
    }

    const typedKey = key as any
    await saveConfig({ [typedKey]: value })
    logSuccess(`Config updated: ${key}`)
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export async function deleteKey(): Promise<void> {
  try {
    const response = await prompts({
      type: 'confirm',
      name: 'value',
      message: 'Delete the stored API key?',
      initial: false,
    })

    if (response.value) {
      await saveConfig({ apiKey: '', apiKeyPrefix: '' })
      logSuccess('API key deleted.')
    }
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
