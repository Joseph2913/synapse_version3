export class CliError extends Error {
  constructor(
    message: string,
    public code: string = 'CLI_ERROR',
    public statusCode: number = 1
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export class ConfigError extends CliError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 1)
    this.name = 'ConfigError'
  }
}

export class AuthError extends CliError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR', 401)
    this.name = 'AuthError'
  }
}

export class McpError extends CliError {
  constructor(message: string, public mcpCode?: number) {
    super(message, 'MCP_ERROR', 1)
    this.name = 'McpError'
  }
}

export class ValidationError extends CliError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 2)
    this.name = 'ValidationError'
  }
}

export class NetworkError extends CliError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR', 3)
    this.name = 'NetworkError'
  }
}

export function formatError(error: unknown): string {
  if (error instanceof CliError) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
