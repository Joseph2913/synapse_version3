import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 30

const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY!
const RESEND_API_KEY            = process.env.RESEND_API_KEY!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('[supabase] Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY')
}


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

function getServiceSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

function getAnonSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}

// ─── AUTH: verify Supabase JWT ──────────────────────────────────────────────

async function verifyUser(req: VercelRequest): Promise<string | null> {
  const auth = req.headers['authorization']
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const { data } = await getAnonSupabase().auth.getUser(token)
  return data.user?.id ?? null
}

// ─── MARKDOWN → EMAIL HTML ──────────────────────────────────────────────────

function markdownToEmailHTML(md: string): string {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  html = html.replace(/^### (.+)$/gm,
    '<h4 style="margin: 16px 0 6px 0; font-size: 13px; font-weight: 700; color: #1a1a1a; letter-spacing: 0.02em;">$1</h4>')
  html = html.replace(/^## (.+)$/gm,
    '<h3 style="margin: 18px 0 8px 0; font-size: 14px; font-weight: 700; color: #1a1a1a;">$1</h3>')
  html = html.replace(/\*\*(.+?)\*\*/g,
    '<strong style="font-weight: 600; color: #111827;">$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  html = html.replace(
    /((?:^\d+\..+$\n?)+)/gm,
    (block) => {
      const items = block.trim().split('\n').map(line => {
        const text = line.replace(/^\d+\.\s*/, '')
        return `<li style="margin-bottom: 6px; padding-left: 4px; color: #374151;">${text}</li>`
      }).join('')
      return `<ol style="margin: 8px 0 12px 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">${items}</ol>`
    }
  )

  html = html.replace(
    /((?:^[\-\*] .+$\n?)+)/gm,
    (block) => {
      const items = block.trim().split('\n').map(line => {
        const text = line.replace(/^[\-\*]\s*/, '')
        return `<li style="margin-bottom: 6px; padding-left: 4px; color: #374151;">${text}</li>`
      }).join('')
      return `<ul style="margin: 8px 0 12px 0; padding-left: 20px; font-size: 14px; line-height: 1.6; list-style-type: disc;">${items}</ul>`
    }
  )

  html = html.replace(/^---+$/gm,
    '<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">')

  html = html.split(/\n{2,}/).map(block => {
    const trimmed = block.trim()
    if (!trimmed) return ''
    if (trimmed.startsWith('<')) return trimmed
    return `<p style="margin: 0 0 12px 0; font-size: 14px; line-height: 1.7; color: #374151;">${trimmed.replace(/\n/g, '<br>')}</p>`
  }).join('')

  return html
}

const MODULE_ICONS: Record<string, string> = {
  active_project_status: '📋', todays_priorities: '🎯', people_pulse: '👥',
  attention_map: '🗺️', signals_alerts: '⚡', learning_gaps: '📚',
  weekly_progress: '📈', emerging_themes: '🌱', relationship_dynamics: '🤝',
  decision_audit: '⚖️', knowledge_velocity: '🚀', week_ahead: '📅',
  strategic_arc: '🧭', goal_trajectory: '🏁', network_evolution: '🕸️',
  knowledge_portfolio: '💼', hypothesis_review: '🔬', monthly_priorities: '📊',
  custom_agent: '🤖',
}

// ─── EMAIL RENDERING ─────────────────────────────────────────────────────────

function renderDigestHTML(
  title: string,
  executiveSummary: string,
  modules: Array<{ name: string; content: string; templateId?: string; error?: string }>,
  generatedAt: string
): string {
  const date = new Date(generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
  const time = new Date(generatedAt).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  })

  const moduleCount = modules.length
  const successCount = modules.filter(m => !m.error).length

  const moduleHTML = modules.map((m, i) => {
    const icon = MODULE_ICONS[m.templateId ?? ''] ?? '📄'
    const isError = !!m.error
    const isLast = i === modules.length - 1
    const content = isError
      ? `<p style="margin: 0; font-size: 13px; color: #dc2626; font-style: italic;">Unable to generate this module.</p>`
      : markdownToEmailHTML(m.content)

    return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: ${isLast ? '0' : '20px'};">
      <tr>
        <td style="padding: 20px 24px; background: ${isError ? '#fef2f2' : '#ffffff'}; border: 1px solid ${isError ? '#fecaca' : '#f0f0f0'}; border-radius: 8px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-bottom: 12px; border-bottom: 1px solid ${isError ? '#fecaca' : '#f0f0f0'};">
                <span style="font-size: 16px; line-height: 1;">${icon}</span>
                <span style="font-size: 14px; font-weight: 700; color: #111827; font-family: 'Segoe UI', Helvetica, Arial, sans-serif; vertical-align: middle; padding-left: 6px;">${m.name}</span>
              </td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-top: 14px; font-family: 'Segoe UI', Helvetica, Arial, sans-serif;">${content}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`
  }).join('')

  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
    body, td, th { font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f4;">
  <div style="display: none; max-height: 0; overflow: hidden;">${executiveSummary.substring(0, 120)}...</div>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f4;">
    <tr><td align="center" style="padding: 32px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; margin: 0 auto;">
        <tr><td style="padding: 0 0 24px 0; text-align: center;">
          <span style="font-size: 24px; font-weight: 700; color: #d63a00; letter-spacing: -0.5px;">synapse</span><br>
          <span style="font-size: 12px; color: #a8a29e;">${date} &middot; ${time}</span>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #ffffff; border-radius: 12px; border: 1px solid #e7e5e4;">
            <tr><td style="padding: 28px 32px 20px 32px;">
              <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #0c0a09;">${title}</h1>
              <p style="margin: 6px 0 0 0; font-size: 12px; color: #a8a29e;">${successCount} of ${moduleCount} modules &middot; Generated from your knowledge graph</p>
            </td></tr>
            <tr><td style="padding: 0 32px;"><div style="border-top: 1px solid #f0f0f0;"></div></td></tr>
            <tr><td style="padding: 20px 32px 24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #fafaf9; border-radius: 8px; border: 1px solid #f0f0f0;">
                <tr><td style="padding: 18px 20px;">
                  <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #d63a00;">Executive Summary</span>
                  <div style="margin-top: 8px;">${markdownToEmailHTML(executiveSummary)}</div>
                </td></tr>
              </table>
            </td></tr>
            <tr><td style="padding: 0 32px;"><div style="border-top: 1px solid #f0f0f0;"></div></td></tr>
            <tr><td style="padding: 20px 32px 16px 32px;">
              <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #a8a29e;">Intelligence Modules</span>
            </td></tr>
            <tr><td style="padding: 0 32px 28px 32px;">${moduleHTML}</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding: 24px 0; text-align: center;">
          <a href="https://connectsynapse.com" style="font-size: 13px; font-weight: 600; color: #d63a00; text-decoration: none;">Open Synapse &rarr;</a><br>
          <span style="font-size: 11px; color: #c7c2be;">Your personal knowledge graph</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
// POST /api/digest/send
// Accepts an already-generated digest and sends it as an email.
// Body: { email, title, executiveSummary, modules[], generatedAt }
// Auth: Supabase JWT Bearer token

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = await verifyUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const { email, title, executiveSummary, modules, generatedAt } = req.body as {
    email?: string
    title?: string
    executiveSummary?: string
    modules?: Array<{ templateName: string; content: string; templateId: string; error?: string }>
    generatedAt?: string
  }

  if (!email || !title || !executiveSummary || !modules || !generatedAt) {
    return res.status(400).json({ error: 'Missing required fields: email, title, executiveSummary, modules, generatedAt' })
  }

  try {
    const subject = `${title} — ${new Date(generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    const html = renderDigestHTML(
      title,
      executiveSummary,
      modules.map(m => ({ name: m.templateName, content: m.content, templateId: m.templateId, error: m.error })),
      generatedAt
    )

    // Check if Resend is configured
    if (!RESEND_API_KEY) {
      return res.status(200).json({
        success: false,
        emailSent: false,
        error: 'Email delivery not configured (RESEND_API_KEY missing)',
        html, // Still return HTML for preview
      })
    }

    // Send via Resend
    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Synapse <onboarding@resend.dev>',
        to: [email],
        subject,
        html,
      }),
    })

    if (!emailResp.ok) {
      const err = await emailResp.text()
      // Return HTML for preview even if email fails
      return res.status(200).json({
        success: false,
        emailSent: false,
        error: `Email delivery failed: ${err}`,
        html,
      })
    }

    return res.status(200).json({ success: true, emailSent: true, html })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return res.status(500).json({ success: false, error: msg })
  }
}
