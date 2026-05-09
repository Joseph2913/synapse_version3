import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_CONFIG } from './constants.js'
import { ConfigError } from './errors.js'
import type { SynapseConfig } from '../types.js'

export async function ensureConfigDir(): Promise<void> {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
    }
  } catch (error) {
    throw new ConfigError(`Failed to create config directory: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function loadConfig(): Promise<SynapseConfig> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      throw new ConfigError(
        `Config file not found. Run 'synapse config init' to set up your connection.`
      )
    }

    const content = await fs.readFile(CONFIG_FILE, 'utf-8')
    const config = JSON.parse(content) as SynapseConfig

    // Validate required fields
    if (!config.apiUrl || !config.apiKey) {
      throw new ConfigError('Config file is incomplete. Run synapse config init.')
    }

    return config
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function saveConfig(config: Partial<SynapseConfig>): Promise<void> {
  try {
    await ensureConfigDir()

    // Load existing config if it exists
    let existing: SynapseConfig = DEFAULT_CONFIG as SynapseConfig
    if (existsSync(CONFIG_FILE)) {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8')
      existing = JSON.parse(content)
    }

    // Merge configs
    const merged = { ...existing, ...config }

    // Write with restricted permissions (600)
    await fs.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), {
      mode: 0o600,
    })
  } catch (error) {
    throw new ConfigError(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****'
  return key.substring(0, 8) + '****'
}

export async function getConfigValue(key: keyof SynapseConfig): Promise<string | undefined> {
  const config = await loadConfig()
  const value = config[key]
  return value ? String(value) : undefined
}

export async function setConfigValue(
  key: keyof SynapseConfig,
  value: string | number | boolean
): Promise<void> {
  const config: Record<string, unknown> = {}
  config[key] = value === 'true' ? true : value === 'false' ? false : value
  await saveConfig(config as Partial<SynapseConfig>)
}
