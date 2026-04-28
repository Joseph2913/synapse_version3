import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 120

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GEMINI_API_KEY            = process.env.GEMINI_API_KEY!
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'

if (!GEMINI_API_KEY) {
  throw new Error('[gemini] Missing env var: GEMINI_API_KEY')
}
const RESEND_API_KEY            = process.env.RESEND_API_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────

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

function verifyAuth(req: VercelRequest): boolean {
  const auth = req.headers['authorization']
  if (!auth) return false
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true
  return false
}

// ─── GEMINI HELPERS ───────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
    }),
  })
  if (!resp.ok) throw new Error(`Embedding failed: ${resp.statusText}`)
  const data = await resp.json()
  return data.embedding?.values ?? []
}

async function generateWithGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }),
  })
  if (!resp.ok) throw new Error(`Gemini generation failed: ${resp.statusText}`)
  const data = await resp.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

// ─── DENSITY INSTRUCTIONS ─────────────────────────────────────────────────────

const DENSITY_INSTRUCTIONS: Record<string, string> = {
  brief: 'Respond in 2–3 sentences. Focus on the single most important finding only.',
  standard: 'Respond in 1–2 paragraphs. Cover key findings with enough context to be actionable.',
  comprehensive: 'Provide detailed analysis in 3–4 paragraphs. Include supporting evidence, related entities, and specific recommendations.',
}

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { name: string; systemPrompt: string }> = {
  active_project_status: { name: 'Active Project Status', systemPrompt: 'Analyze my knowledge graph for active Project and Goal entities. For each project found, report: current status based on recent connections, new entities linked recently, pending Action items connected to it, and any Risk or Blocker entities associated with it.' },
  todays_priorities: { name: "Today's Priorities", systemPrompt: 'Review Action, Decision, and Goal entities in my knowledge graph. Identify what requires attention today based on recency, connection density, and urgency signals. Rank the top 5 priorities.' },
  people_pulse: { name: 'People Pulse', systemPrompt: 'Analyze Person entities in my knowledge graph. For each key person, identify recent interactions, associated topics, pending actions involving them, and connection pattern changes.' },
  attention_map: { name: 'Attention Map', systemPrompt: 'Map where my attention has been focused recently. Analyze distribution of new entities and edges across topics, projects, and entity types. Identify which areas are most active and which have gone quiet.' },
  signals_alerts: { name: 'Signals & Alerts', systemPrompt: 'Scan my knowledge graph for risks, blockers, and urgent signals. Look for Risk and Blocker entities, contradicting relationships, long-pending decisions, and declining project activity.' },
  learning_gaps: { name: 'Learning Gaps', systemPrompt: 'Analyze my knowledge graph for learning opportunities. Identify unanswered Questions, Topics with few connections, and areas with structural knowledge gaps.' },
  weekly_progress: { name: 'Weekly Progress', systemPrompt: 'Summarize the past week of knowledge activity: new entities, new relationships, sources ingested, goals advanced, decisions made, and actions completed.' },
  emerging_themes: { name: 'Emerging Themes', systemPrompt: 'Identify emerging themes over the past week. Look for clusters of related entities, rapidly growing topics, cross-domain connections, and recurring concepts.' },
  relationship_dynamics: { name: 'Relationship Dynamics', systemPrompt: 'Analyze how relationships have evolved over the past week. Identify new collaborations, changing dynamics, team interactions, and notable relationship patterns.' },
  decision_audit: { name: 'Decision Audit', systemPrompt: 'Review Decision entities. Assess supporting evidence, associated risks, follow-up actions, and contradicting signals. Flag decisions needing revisiting.' },
  knowledge_velocity: { name: 'Knowledge Velocity', systemPrompt: 'Measure knowledge accumulation velocity across domains. Analyze which topics grow fastest, which plateaued, and where the deepest understanding exists.' },
  week_ahead: { name: 'Week Ahead', systemPrompt: 'Project what needs attention next week: pending actions, upcoming milestones, materializing risks, people to follow up with, and topics to explore.' },
  strategic_arc: { name: 'Strategic Arc', systemPrompt: 'Analyze the strategic arc of knowledge over the past month: theme shifts, goal progression, strategic pivots, and evolving focus areas.' },
  goal_trajectory: { name: 'Goal Trajectory', systemPrompt: 'Evaluate trajectory of all Goal entities: progress based on actions/decisions, supporting/blocking factors, and recommended corrections.' },
  network_evolution: { name: 'Network Evolution', systemPrompt: 'Analyze professional network evolution: new people, changing relationship strengths, forming/dissolving clusters, key connectors.' },
  knowledge_portfolio: { name: 'Knowledge Portfolio', systemPrompt: 'Assess knowledge portfolio balance: topic investment distribution, deep vs shallow understanding areas, and gaps vs priorities.' },
  hypothesis_review: { name: 'Hypothesis Review', systemPrompt: 'Review Hypothesis entities: evaluate evidence for/against, assess confidence, identify needed evidence, flag for promotion or abandonment.' },
  monthly_priorities: { name: 'Monthly Priorities', systemPrompt: 'Establish priorities for the coming month based on goal trajectories, emerging themes, pending decisions, and strategic direction.' },
}

const TEMPLATE_ALIASES: Record<string, string> = {
  weekly_progress_review: 'weekly_progress',
  weekly_next_week_preview: 'week_ahead',
}

function resolveTemplateId(id: string): string {
  return TEMPLATE_ALIASES[id] ?? id
}

// ─── RAG ──────────────────────────────────────────────────────────────────────

async function runModuleRAG(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  modulePrompt: string,
  density: string
): Promise<{ content: string; sourceCount: number }> {
  const embedding = await embedText(modulePrompt.substring(0, 500))

  const { data: chunks } = await supabase.rpc('match_source_chunks', {
    query_embedding: embedding,
    match_threshold: 0.35,
    match_count: 12,
    p_user_id: userId,
  })

  const { data: nodes } = await supabase.rpc('match_knowledge_nodes', {
    query_embedding: embedding,
    match_threshold: 0.35,
    match_count: 15,
    p_user_id: userId,
  })

  const chunkContext = (chunks ?? [])
    .map((c: { content: string; source_title?: string }) =>
      `[Source: ${c.source_title ?? 'Unknown'}]\n${c.content}`)
    .join('\n\n')

  const nodeContext = (nodes ?? [])
    .map((n: { label: string; entity_type: string; description?: string }) =>
      `• ${n.entity_type}: ${n.label}${n.description ? ` — ${n.description}` : ''}`)
    .join('\n')

  const densityInstruction = DENSITY_INSTRUCTIONS[density] ?? DENSITY_INSTRUCTIONS.standard

  const content = await generateWithGemini(
    `You are an intelligence analyst for a personal knowledge graph. Synthesize the provided context to answer the user's query. Be specific, cite entities by name, and be actionable. ${densityInstruction}`,
    `## Knowledge Graph Entities\n${nodeContext || 'No entities found.'}\n\n## Source Documents\n${chunkContext || 'No source documents found.'}\n\n## Task\n${modulePrompt}`
  )

  return { content, sourceCount: (chunks ?? []).length + (nodes ?? []).length }
}

// ─── MARKDOWN → EMAIL HTML ────────────────────────────────────────────────────
// Converts Gemini markdown output into email-safe inline-styled HTML.

function markdownToEmailHTML(md: string): string {
  // Escape HTML entities first
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Headers: ### → h4, ## → h3 (we reserve h2 for module titles)
  html = html.replace(/^### (.+)$/gm,
    '<h4 style="margin: 16px 0 6px 0; font-size: 13px; font-weight: 700; color: #1a1a1a; letter-spacing: 0.02em;">$1</h4>')
  html = html.replace(/^## (.+)$/gm,
    '<h3 style="margin: 18px 0 8px 0; font-size: 14px; font-weight: 700; color: #1a1a1a;">$1</h3>')

  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g,
    '<strong style="font-weight: 600; color: #111827;">$1</strong>')

  // Italic: *text*
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Numbered lists: lines starting with "1. ", "2. ", etc.
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

  // Bullet lists: lines starting with "- " or "* "
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

  // Horizontal rules
  html = html.replace(/^---+$/gm,
    '<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">')

  // Paragraphs: split by double newlines, wrap non-tag content in <p>
  html = html.split(/\n{2,}/).map(block => {
    const trimmed = block.trim()
    if (!trimmed) return ''
    if (trimmed.startsWith('<')) return trimmed
    return `<p style="margin: 0 0 12px 0; font-size: 14px; line-height: 1.7; color: #374151;">${trimmed.replace(/\n/g, '<br>')}</p>`
  }).join('')

  return html
}

// ─── MODULE ICON MAPPING ─────────────────────────────────────────────────────

const MODULE_ICONS: Record<string, string> = {
  active_project_status: '📋', todays_priorities: '🎯', people_pulse: '👥',
  attention_map: '🗺️', signals_alerts: '⚡', learning_gaps: '📚',
  weekly_progress: '📈', emerging_themes: '🌱', relationship_dynamics: '🤝',
  decision_audit: '⚖️', knowledge_velocity: '🚀', week_ahead: '📅',
  strategic_arc: '🧭', goal_trajectory: '🏁', network_evolution: '🕸️',
  knowledge_portfolio: '💼', hypothesis_review: '🔬', monthly_priorities: '📊',
  custom_agent: '🤖',
}

// ─── EMAIL RENDERING ──────────────────────────────────────────────────────────

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
      ? `<p style="margin: 0; font-size: 13px; color: #dc2626; font-style: italic;">Unable to generate this module. This may be due to insufficient data in your knowledge graph for this topic.</p>`
      : markdownToEmailHTML(m.content)

    return `
    <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: ${isLast ? '0' : '20px'};">
      <tr>
        <td style="padding: 20px 24px; background: ${isError ? '#fef2f2' : '#ffffff'}; border: 1px solid ${isError ? '#fecaca' : '#f0f0f0'}; border-radius: 8px;">
          <!-- Module header -->
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-bottom: 12px; border-bottom: 1px solid ${isError ? '#fecaca' : '#f0f0f0'};">
                <span style="font-size: 16px; line-height: 1;">${icon}</span>
                <span style="font-size: 14px; font-weight: 700; color: #111827; font-family: 'Segoe UI', Helvetica, Arial, sans-serif; vertical-align: middle; padding-left: 6px;">${m.name}</span>
              </td>
            </tr>
          </table>
          <!-- Module content -->
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-top: 14px; font-family: 'Segoe UI', Helvetica, Arial, sans-serif;">
                ${content}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->`
  }).join('')

  return `
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${title}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style>table{border-collapse:collapse;}td{font-family:'Segoe UI',Helvetica,Arial,sans-serif;}</style>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
    body, td, th { font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif; }
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; padding: 16px !important; }
      .card-padding { padding: 20px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f4; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">

  <!-- Preheader (hidden preview text) -->
  <div style="display: none; max-height: 0; overflow: hidden; font-size: 1px; line-height: 1px; color: #f5f5f4;">
    ${executiveSummary.substring(0, 120)}...
  </div>

  <!-- Outer wrapper table for full-width background -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f4;">
    <tr>
      <td align="center" style="padding: 32px 16px;">

        <!-- Email container -->
        <!--[if mso]><table width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
        <table class="email-container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; margin: 0 auto;">

          <!-- ━━━ HEADER ━━━ -->
          <tr>
            <td style="padding: 0 0 24px 0; text-align: center;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom: 4px;">
                    <span style="font-size: 24px; font-weight: 700; color: #d63a00; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif; letter-spacing: -0.5px;">synapse</span>
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <span style="font-size: 12px; color: #a8a29e; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif;">${date} &middot; ${time}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ━━━ MAIN CARD ━━━ -->
          <tr>
            <td>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e7e5e4;">

                <!-- Title bar -->
                <tr>
                  <td class="card-padding" style="padding: 28px 32px 20px 32px;">
                    <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #0c0a09; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif; letter-spacing: -0.3px;">${title}</h1>
                    <p style="margin: 6px 0 0 0; font-size: 12px; color: #a8a29e; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif;">${successCount} of ${moduleCount} modules &middot; Generated from your knowledge graph</p>
                  </td>
                </tr>

                <!-- Divider -->
                <tr><td style="padding: 0 32px;"><div style="border-top: 1px solid #f0f0f0;"></div></td></tr>

                <!-- Executive Summary -->
                <tr>
                  <td class="card-padding" style="padding: 20px 32px 24px 32px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #fafaf9; border-radius: 8px; border: 1px solid #f0f0f0;">
                      <tr>
                        <td style="padding: 18px 20px;">
                          <table width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="padding-bottom: 8px;">
                                <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #d63a00; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif;">Executive Summary</span>
                              </td>
                            </tr>
                            <tr>
                              <td>
                                <p style="margin: 0; font-size: 14px; line-height: 1.7; color: #292524; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif;">${markdownToEmailHTML(executiveSummary)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Divider -->
                <tr><td style="padding: 0 32px;"><div style="border-top: 1px solid #f0f0f0;"></div></td></tr>

                <!-- Module section header -->
                <tr>
                  <td class="card-padding" style="padding: 20px 32px 16px 32px;">
                    <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #a8a29e; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif;">Intelligence Modules</span>
                  </td>
                </tr>

                <!-- Modules -->
                <tr>
                  <td class="card-padding" style="padding: 0 32px 28px 32px;">
                    ${moduleHTML}
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- ━━━ FOOTER ━━━ -->
          <tr>
            <td style="padding: 24px 0; text-align: center;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom: 8px;">
                    <a href="https://connectsynapse.com" style="font-size: 13px; font-weight: 600; color: #d63a00; text-decoration: none; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif;">Open Synapse &rarr;</a>
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <span style="font-size: 11px; color: #c7c2be; font-family: 'DM Sans', 'Segoe UI', Helvetica, Arial, sans-serif;">Your personal knowledge graph &middot; <a href="https://connectsynapse.com/settings" style="color: #c7c2be; text-decoration: underline;">Manage digest settings</a></span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <!--[if mso]></td></tr></table><![endif]-->

      </td>
    </tr>
  </table>

</body>
</html>`
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────
// POST /api/digest/send-test
// Body: { profileId: string, email: string }
// Generates a fresh digest from the given profile and sends it to the given email.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (!verifyAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

  const { profileId, email } = req.body as { profileId?: string; email?: string }
  if (!profileId || !email) {
    return res.status(400).json({ error: 'profileId and email are required' })
  }

  const startTime = Date.now()
  const sb = getSupabase()

  try {
    // Fetch profile with modules
    const { data: profile, error: profileError } = await sb
      .from('digest_profiles')
      .select(`
        id, user_id, title, frequency, density,
        digest_modules ( id, template_id, sort_order, is_active, custom_context )
      `)
      .eq('id', profileId)
      .single()

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const userId = profile.user_id as string
    const title = profile.title as string
    const density = (profile.density as string) || 'standard'

    const modules = ((profile.digest_modules ?? []) as Array<{
      template_id: string; is_active: boolean; custom_context: string | null; sort_order: number
    }>)
      .filter(m => m.is_active)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

    // Generate modules
    const moduleOutputs: Array<{ name: string; content: string; templateId: string; durationMs: number; error?: string }> = []

    for (const mod of modules) {
      const moduleStart = Date.now()
      const templateId = mod.template_id as string

      if (templateId === 'custom_agent') {
        let customConfig: { name?: string; task?: string; behavior?: string; goal?: string; outputFormat?: string } = {}
        try { customConfig = JSON.parse(mod.custom_context ?? '{}') } catch { continue }
        if (!customConfig.task?.trim()) continue

        const moduleName = customConfig.name?.trim() || 'Custom Agent'
        try {
          let prompt = customConfig.task
          if (customConfig.behavior?.trim()) prompt += `\n\nApproach: ${customConfig.behavior}`
          if (customConfig.goal?.trim()) prompt += `\n\nGoal: ${customConfig.goal}`

          const result = await runModuleRAG(sb, userId, prompt, density)
          moduleOutputs.push({ name: moduleName, content: result.content, templateId, durationMs: Date.now() - moduleStart })
        } catch (err) {
          moduleOutputs.push({ name: moduleName, content: '', templateId, durationMs: Date.now() - moduleStart, error: err instanceof Error ? err.message : 'Unknown error' })
        }
        continue
      }

      const resolvedId = resolveTemplateId(templateId)
      const template = TEMPLATES[resolvedId]
      if (!template) continue

      try {
        const result = await runModuleRAG(sb, userId, template.systemPrompt, density)
        moduleOutputs.push({ name: template.name, content: result.content, templateId, durationMs: Date.now() - moduleStart })
      } catch (err) {
        moduleOutputs.push({ name: template.name, content: '', templateId, durationMs: Date.now() - moduleStart, error: err instanceof Error ? err.message : 'Unknown error' })
      }
    }

    // Executive summary
    let executiveSummary = ''
    const successfulModules = moduleOutputs.filter(m => !m.error)
    if (successfulModules.length > 0) {
      const ctx = successfulModules.map(m => `[${m.name}]: ${m.content}`).join('\n\n')
      executiveSummary = await generateWithGemini(
        'You are a concise intelligence analyst. Write a 2-3 sentence executive summary.',
        `Highlight the most important findings and cross-module patterns:\n\n${ctx}`
      )
    } else {
      executiveSummary = 'All modules encountered errors during generation.'
    }

    // Send email
    const generatedAt = new Date().toISOString()
    const subject = `${title} — ${new Date(generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    const html = renderDigestHTML(
      title, executiveSummary,
      moduleOutputs.map(m => ({ name: m.name, content: m.content, templateId: m.templateId, error: m.error })),
      generatedAt
    )

    const emailResult = await sendEmail(email, subject, html)

    // Save to history
    await sb.from('digest_history').insert({
      digest_profile_id: profileId,
      user_id: userId,
      generated_at: generatedAt,
      content: { profileId, title, generatedAt, executiveSummary, modules: moduleOutputs, totalDurationMs: Date.now() - startTime },
      module_outputs: moduleOutputs,
      executive_summary: executiveSummary,
      density,
      generation_duration_ms: Date.now() - startTime,
      status: emailResult.success ? 'delivered' : 'generated',
      delivery_results: [{ channelType: 'email', success: emailResult.success, error: emailResult.error, sentAt: generatedAt }],
    })

    return res.status(200).json({
      success: true,
      emailSent: emailResult.success,
      emailError: emailResult.error,
      modules: moduleOutputs.length,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[send-test] Error:', msg)
    return res.status(500).json({ success: false, error: msg })
  }
}

async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<{ success: boolean; error?: string }> {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Synapse <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  })

  if (!resp.ok) {
    const err = await resp.text()
    return { success: false, error: `Resend error ${resp.status}: ${err}` }
  }

  return { success: true }
}
