/**
 * Lightweight local API server for running Vercel serverless functions.
 * Proxied from Vite dev server via /api -> localhost:3001
 */
import http from 'http'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '..', '.env.local')

// Manual dotenv parsing
const envContent = readFileSync(envPath, 'utf-8')
for (const line of envContent.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx === -1) continue
  const key = trimmed.slice(0, eqIdx).trim()
  let val = trimmed.slice(eqIdx + 1).trim()
  // Strip quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  if (!process.env[key]) process.env[key] = val
}

// Dynamic import of the compiled function
async function loadHandler(apiPath) {
  // Map /api/skills/scan -> api/skills/scan.ts
  // We use tsx to run TypeScript directly
  const modulePath = resolve(__dirname, '..', apiPath + '.ts')
  const mod = await import(modulePath)
  return mod.default
}

const server = http.createServer(async (req, res) => {
  // Parse URL
  const url = new URL(req.url, `http://localhost:3001`)
  const pathname = url.pathname

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`)

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Only handle /api/ routes
  if (!pathname.startsWith('/api/')) {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }

  // Read body
  let body = ''
  for await (const chunk of req) {
    body += chunk
  }

  // Build mock VercelRequest/VercelResponse
  const vercelReq = {
    method: req.method,
    headers: req.headers,
    body: body ? JSON.parse(body) : {},
    query: Object.fromEntries(url.searchParams),
    url: pathname,
  }

  let statusCode = 200
  let responseBody = null
  const vercelRes = {
    status(code) { statusCode = code; return this },
    json(data) {
      responseBody = data
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    },
    send(data) {
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' })
      res.end(data)
    },
    setHeader(k, v) { res.setHeader(k, v); return this },
  }

  try {
    // Strip /api/ prefix and map to file
    const apiFile = pathname.replace(/^\//, '')
    const handler = await loadHandler(apiFile)
    await handler(vercelReq, vercelRes)
  } catch (err) {
    console.error('Handler error:', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  }
})

server.listen(3001, () => {
  console.log('API server running at http://localhost:3001')
  console.log('Proxied from Vite at http://localhost:5173/api/*')
})
