import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MAX_CONTENT_LENGTH = 100_000;
const FETCH_TIMEOUT_MS = 15_000;

// ─── HTML to text conversion ─────────────────────────────────────────────────


// ─── Structured logging ─────────────────────────────────────────────────────

type LogStatus = 'ok' | 'failed' | 'partial' | 'skipped'

interface LogFields {
  stage: string
  user_id?: string
  source_id?: string
  duration_ms?: number
  status?: LogStatus
  error?: string
  [k: string]: unknown
}

function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

function logError(fields: LogFields & { error: string }): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim() ?? null;
}

function htmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

  // Try to extract from <article> or <main> first for cleaner content
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch?.[1]) {
    text = articleMatch[1];
  } else if (mainMatch?.[1]) {
    text = mainMatch[1];
  } else {
    // Fall back to body content
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch?.[1]) {
      text = bodyMatch[1];
    }
  }

  // Convert block elements to newlines
  text = text.replace(/<(?:p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n');
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&[a-z]+;/gi, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify user auth
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.slice(7);
  const supabase = getSupabase();

  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SynapseBot/1.0)',
        'Accept': 'text/html, application/xhtml+xml, text/plain, */*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return res.status(422).json({ error: `Failed to fetch URL: HTTP ${response.status}` });
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isHtml = contentType.includes('text/html') || contentType.includes('xhtml');
    const isText = contentType.includes('text/') || contentType.includes('json');

    if (!isHtml && !isText) {
      return res.status(422).json({
        error: 'URL does not point to readable content (HTML or text). Binary content is not supported.',
      });
    }

    let rawContent = await response.text();
    if (rawContent.length > MAX_CONTENT_LENGTH * 2) {
      rawContent = rawContent.substring(0, MAX_CONTENT_LENGTH * 2);
    }

    let title: string | null = null;
    let content: string;

    if (isHtml) {
      title = extractTitle(rawContent);
      content = htmlToText(rawContent);
    } else {
      content = rawContent;
    }

    // Truncate to limit
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.substring(0, MAX_CONTENT_LENGTH);
    }

    return res.status(200).json({
      title: title ?? parsedUrl.hostname,
      content,
      url: parsedUrl.href,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return res.status(422).json({ error: 'Request timed out — the page took too long to respond.' });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[content/fetch] Error:', err);
    return res.status(500).json({ error: msg });
  }
}
