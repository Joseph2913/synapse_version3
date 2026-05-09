import { loadConfig } from './config.js'
import { AuthError, McpError, NetworkError } from './errors.js'
import type { JsonRpcRequest, JsonRpcResponse } from '../types.js'

let requestId = 0

function getNextRequestId(): string {
  return `cli-${++requestId}`
}

export async function callMcp(
  toolName: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const config = await loadConfig()

  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: params,
    },
    id: getNextRequestId(),
  }

  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(request),
    })

    if (response.status === 401) {
      throw new AuthError(
        'Unauthorized. Your API key may be invalid or expired. Run "synapse config init" to update.'
      )
    }

    if (response.status === 404) {
      throw new McpError(
        `MCP endpoint not found at ${config.apiUrl}. Check your apiUrl in config.`
      )
    }

    if (!response.ok) {
      const text = await response.text()
      throw new McpError(`MCP server error: ${response.status} ${text.substring(0, 200)}`)
    }

    const jsonResponse = (await response.json()) as JsonRpcResponse

    if (jsonResponse.error) {
      throw new McpError(
        `MCP error: ${jsonResponse.error.message}`,
        jsonResponse.error.code
      )
    }

    if (!jsonResponse.result) {
      throw new McpError('Empty response from MCP server')
    }

    return jsonResponse.result
  } catch (error) {
    if (error instanceof AuthError || error instanceof McpError) {
      throw error
    }

    if (error instanceof TypeError || (error instanceof Error && error.message.includes('fetch'))) {
      throw new NetworkError(
        `Failed to connect to ${config.apiUrl}. Is the MCP server running?`
      )
    }

    throw error
  }
}

export async function toolExists(toolName: string): Promise<boolean> {
  try {
    // Quick validation by checking if tool is callable
    // For now, we just validate against known tool names
    const knownTools = [
      'ask_synapse',
      'search_entities',
      'get_entity',
      'get_connections',
      'list_anchors',
      'get_recent_sources',
      'get_source_content',
      'search_sources',
      'get_meeting_brief',
      'get_related_sources',
      'get_meeting_notes',
      'get_meeting_transcript',
      'consult_council',
      'send_to_synapse',
    ]
    return knownTools.includes(toolName)
  } catch {
    return false
  }
}
