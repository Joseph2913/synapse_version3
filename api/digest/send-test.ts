import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 120

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GEMINI_API_KEY            = process.env.GEMINI_API_KEY!
const RESEND_API_KEY            = process.env.RESEND_API_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────
function verifyAuth(req: VercelRequest): boolean {
  const auth = req.headers['authorization']
  if (!auth) return false
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true
  return false
}

// ─── GEMINI HELPERS ───────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
    }),
  })
  if (!resp.ok) throw new Error(`Embedding failed: ${resp.statusText}`)
  const data = await resp.json()
  return data.embedding?.values ?? []
}

async function generateWithGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`
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

// ─── EMAIL RENDERING ──────────────────────────────────────────────────────────

function renderDigestHTML(
  title: string,
  executiveSummary: string,
  modules: Array<{ name: string; content: string; error?: string }>,
  generatedAt: string
): string {
  const moduleHTML = modules.map(m => `
    <div style="margin-bottom: 24px; padding: 16px; background: #f9fafb; border-radius: 8px; border-left: 3px solid ${m.error ? '#ef4444' : '#d63a00'};">
      <h3 style="margin: 0 0 8px 0; font-size: 15px; font-weight: 600; color: #1a1a1a;">${m.name}</h3>
      <div style="font-size: 14px; line-height: 1.6; color: #374151; white-space: pre-wrap;">${m.error ? `<em style="color: #ef4444;">Error: ${m.error}</em>` : m.content}</div>
    </div>
  `).join('')

  const date = new Date(generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
  const time = new Date(generatedAt).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
  })

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 640px; margin: 0 auto; padding: 32px 16px;">
    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #d63a00;">Synapse</h1>
      <p style="margin: 4px 0 0; font-size: 12px; color: #9ca3af;">${date} · ${time}</p>
    </div>
    <div style="background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 700; color: #1a1a1a;">${title}</h2>
      <div style="margin-bottom: 24px; padding: 16px; background: #fff7ed; border-radius: 8px; border-left: 3px solid #d63a00;">
        <p style="margin: 0 0 4px 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #d63a00;">Executive Summary</p>
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #374151;">${executiveSummary}</p>
      </div>
      ${moduleHTML}
    </div>
    <div style="text-align: center; margin-top: 24px; padding: 16px;">
      <p style="margin: 0; font-size: 12px; color: #9ca3af;">Generated by <a href="https://connectsynapse.com" style="color: #d63a00; text-decoration: none;">Synapse</a></p>
    </div>
  </div>
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

      const template = TEMPLATES[templateId]
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
      moduleOutputs.map(m => ({ name: m.name, content: m.content, error: m.error })),
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
