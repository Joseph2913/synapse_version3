# Synapse CLI

A command-line interface for your personal knowledge graph. Query, search, and manage your Synapse graph directly from the terminal.

## Installation

### Local Development

```bash
cd cli
npm install
npm run build
npm link
```

### From npm (production)

```bash
npm install -g synapse-cli
```

## Quick Start

### 1. Initialize Configuration

```bash
synapse config init
```

This will prompt you for:
- **MCP API URL**: Where your MCP server is running (default: `http://localhost:3001/api/mcp`)
- **API Key**: Your `sk-syn-*` key from Synapse settings
- **Output Format**: JSON, table, or text (default: JSON)

Your configuration is saved to `~/.synapse/config.json` with restricted permissions (mode 600).

### 2. Try a Command

```bash
# List your anchors
synapse list anchors

# Ask your knowledge graph
synapse ask "what are my top projects?"

# Search for entities
synapse search entities "kubernetes" --type Technology
```

## Commands

### Query & Search

#### `synapse ask <question>`
Ask your knowledge graph a question using semantic RAG.

```bash
synapse ask "how does anchor scoring work?"
synapse ask "what projects use machine learning?" --limit 20
```

**Options:**
- `--limit <n>` — Maximum results (default: 10)
- `--sources-only` — Return only sources, not the full answer

#### `synapse search entities <query>`
Search for entities by name or description.

```bash
synapse search entities "kubernetes"
synapse search entities "alice" --type Person
synapse search entities "cloud" --type Technology --limit 20
```

**Options:**
- `--type <type>` — Filter by entity type (Person, Project, Technology, etc.)
- `--limit <n>` — Maximum results (default: 10)
- `--source-id <id>` — Filter by source UUID

#### `synapse get entity <label>`
Get detailed information about a specific entity.

```bash
synapse get entity "Kubernetes"
synapse get entity "Alice Johnson"
```

#### `synapse connections <label>`
Traverse the relationship network around an entity.

```bash
synapse connections "Machine Learning"
synapse connections "Kubernetes" --hops 3
```

**Options:**
- `--hops <n>` — Number of relationship hops (1-3, default: 2)

### Entities & Anchors

#### `synapse list anchors`
List all anchor entities (high-signal concepts you've designated as important).

```bash
synapse list anchors
synapse list anchors --format table
```

### Sources

#### `synapse sources`
List recently ingested sources (meetings, documents, YouTube videos, etc.).

```bash
synapse sources
synapse sources --type Meeting --recent 5
synapse sources --participant "Alice" --type Meeting
synapse sources --from "2025-01-01" --to "2025-12-31"
```

**Options:**
- `--type <type>` — Filter by source type (Meeting, YouTube, Document, Note, etc.)
- `--recent <n>` — Number of recent sources (default: 10)
- `--from <date>` — ISO date string (filter from)
- `--to <date>` — ISO date string (filter to)
- `--participant <name>` — Filter by participant name

#### `synapse read <sourceId>`
Read the full content of a source by its UUID.

```bash
synapse read abc-123-def-456
synapse read abc-123-def-456 --format text
```

#### `synapse search sources <query>`
Search for sources by title or content.

```bash
synapse search sources "kubernetes deployment"
synapse search sources "AI" --type Research --limit 20
```

**Options:**
- `--type <type>` — Filter by source type
- `--limit <n>` — Maximum results (default: 10)

### Write to Graph

#### `synapse send <title> [content]`
Send new content to your knowledge graph for extraction and ingestion.

```bash
synapse send "Meeting notes" "We discussed X, Y, and Z..."
synapse send "README.md" --from-file ./README.md
synapse send "Decision log" --from-file ./decisions.txt --repo my-project --branch main
```

**Options:**
- `--from-file <path>` — Read content from a file
- `--repo <name>` — Repository name (optional context)
- `--branch <name>` — Branch name (optional context)
- `--guidance <text>` — Custom guidance for extraction

### Configuration

#### `synapse config init`
Initialize or update your configuration interactively.

```bash
synapse config init
```

#### `synapse config show`
Display current configuration (API key is masked).

```bash
synapse config show
```

#### `synapse config set <key> <value>`
Set individual configuration values.

```bash
synapse config set apiUrl "https://synapse.example.com/api/mcp"
synapse config set outputFormat "table"
```

#### `synapse config delete-key`
Remove the stored API key.

```bash
synapse config delete-key
```

## Output Formats

All commands support output formatting via the configured default or per-command (if you add a `--format` flag).

### JSON (default)
```bash
synapse list anchors
# Output: { "status": "ok", "data": [...] }
```

### Table
```bash
synapse list anchors --format table
```

```
Label              Type      Connections
─────────────────  ────────  ────────────
Kubernetes         Technology  23
Docker             Technology  18
Machine Learning   Concept     14
```

### Text
```bash
synapse list anchors --format text
```

```
• Kubernetes (Technology) — 23 connections
• Docker (Technology) — 18 connections
• Machine Learning (Concept) — 14 connections
```

## Configuration File

Configuration is stored in `~/.synapse/config.json`:

```json
{
  "apiUrl": "http://localhost:3001/api/mcp",
  "apiKey": "sk-syn-...",
  "apiKeyPrefix": "sk-syn-aBcD",
  "outputFormat": "json",
  "defaultSourceLimit": 10,
  "defaultConnectionHops": 2
}
```

**Security:**
- File is readable/writable by owner only (mode 600)
- API key is never logged or printed in full
- The key is shown masked (first 8 chars only) in `config show` output

## Error Handling

The CLI provides clear error messages for common issues:

- **401 Unauthorized** — Your API key is invalid. Run `synapse config init` to update.
- **Connection Failed** — MCP server is not reachable. Check `apiUrl` in config.
- **Invalid Config** — Config file is missing or incomplete. Run `synapse config init`.

All errors exit with a non-zero status code for use in scripts.

## Scripting & Automation

The CLI returns JSON by default, making it easy to parse in shell scripts:

```bash
# Get all anchors and extract labels
synapse list anchors | jq '.data[].label'

# Search and count results
synapse search entities "kubernetes" | jq '.data | length'

# Find meetings with a specific person
synapse sources --participant "Alice" --type Meeting | jq '.data[] | {title, source_type}'
```

## Troubleshooting

### "Config file not found"
Run `synapse config init` to create a new configuration.

### "Unauthorized (401)"
- Your API key may be expired or incorrect.
- Generate a new API key in Synapse settings (Automate → MCP Access).
- Run `synapse config init` to update.

### "Connection failed"
- Verify your MCP server is running: `npm run api` (in the main project)
- Check that `apiUrl` is correct: `synapse config show`
- If running locally, confirm: `curl http://localhost:3001/api/mcp` returns a response.

### "Empty response"
- The tool executed but returned no results.
- Try adjusting filters or running with `--limit` set higher.

## Development

### Build from source

```bash
cd cli
npm install
npm run build
```

### Test locally

```bash
npm link
synapse config init
synapse list anchors
```

### Rebuild on changes

```bash
npm run dev
```

This watches TypeScript files and recompiles automatically.

## Features

✓ Full query API (all 16 MCP tools)  
✓ Semantic search with RAG  
✓ Entity traversal and relationship mapping  
✓ Source management and filtering  
✓ Write content to knowledge graph  
✓ Multiple output formats (JSON, table, text)  
✓ Safe API key storage (mode 600)  
✓ Rich CLI help and examples  

## License

MIT
