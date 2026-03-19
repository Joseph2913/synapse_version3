import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 300

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GEMINI_API_KEY            = process.env.GEMINI_API_KEY!
const RESEND_API_KEY            = process.env.RESEND_API_KEY!
const CRON_SECRET               = process.env.CRON_SECRET

const getSupabase = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── AUTH ──────────────────────────────────────────────────────────────────────
function verifyCronAuth(req: VercelRequest): boolean {
  if (req.headers['x-vercel-signature']) return true
  if (!CRON_SECRET) return true
  const auth = req.headers['authorization']
  return !!(auth && auth === `Bearer ${CRON_SECRET}`)
}

// ─── GEMINI HELPERS (self-contained — serverless constraint) ──────────────────

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

// ─── DIGEST TEMPLATES (inline — serverless constraint) ────────────────────────
// Only need id → systemPrompt + name mapping for generation.

const TEMPLATES: Record<string, { name: string; systemPrompt: string }> = {
  active_project_status: {
    name: 'Active Project Status',
    systemPrompt: `Analyze my knowledge graph for active Project and Goal entities. For each project found, report: current status based on recent connections, new entities linked recently, pending Action items connected to it, and any Risk or Blocker entities associated with it. Organize by project with clear status indicators. If no projects exist, summarize the most active topics.`,
  },
  todays_priorities: {
    name: "Today's Priorities",
    systemPrompt: `Review Action, Decision, and Goal entities in my knowledge graph. Identify what requires attention today based on: recency of creation, connection density (highly connected items are higher priority), and any explicit urgency signals in descriptions or related entities. Rank the top 5 priorities with brief justification for each.`,
  },
  people_pulse: {
    name: 'People Pulse',
    systemPrompt: `Analyze Person entities in my knowledge graph. For each key person, identify: recent interactions (new edges or sources mentioning them), topics they're associated with, any pending actions or decisions involving them, and changes in their connection patterns. Highlight relationship dynamics and collaboration opportunities.`,
  },
  attention_map: {
    name: 'Attention Map',
    systemPrompt: `Map where my attention has been focused recently. Analyze the distribution of new entities and edges across topics, projects, and entity types. Identify: which areas are getting the most activity, which areas have gone quiet, and any emerging clusters of interest. Present as a high-level attention allocation summary.`,
  },
  signals_alerts: {
    name: 'Signals & Alerts',
    systemPrompt: `Scan my knowledge graph for potential risks, blockers, and urgent signals. Look for: Risk and Blocker entities, contradicting relationships, decisions pending too long, projects with declining activity, and entities flagged with urgency. Prioritize by severity and time-sensitivity.`,
  },
  learning_gaps: {
    name: 'Learning Gaps',
    systemPrompt: `Analyze my knowledge graph for learning opportunities. Identify: Questions and Hypothesis entities that remain unanswered, Topics with few connections (shallow understanding), Concepts referenced but not deeply explored, and areas where my knowledge graph has structural gaps compared to related topics.`,
  },
  weekly_progress: {
    name: 'Weekly Progress',
    systemPrompt: `Summarize the past week's knowledge activity. Analyze: new entities added and their types, new relationships formed, sources ingested, goals advanced, decisions made, and actions completed. Compare this week's activity patterns to recent trends and highlight notable changes.`,
  },
  emerging_themes: {
    name: 'Emerging Themes',
    systemPrompt: `Identify emerging themes in my knowledge graph over the past week. Look for: clusters of related entities appearing together, new topics gaining connections rapidly, cross-domain connections forming, and recurring concepts across different sources. Distinguish genuinely new themes from ongoing topics.`,
  },
  relationship_dynamics: {
    name: 'Relationship Dynamics',
    systemPrompt: `Analyze how relationships in my knowledge graph have evolved over the past week. Identify: new collaborations between people, changing power dynamics (who's connected to what decisions), team interactions, and relationship patterns across projects. Highlight relationship changes worth paying attention to.`,
  },
  decision_audit: {
    name: 'Decision Audit',
    systemPrompt: `Review Decision entities in my knowledge graph. For each recent decision, assess: what evidence supports it (connected sources and entities), what risks are associated, what actions follow from it, and whether there are contradicting signals. Flag decisions that may need revisiting.`,
  },
  knowledge_velocity: {
    name: 'Knowledge Velocity',
    systemPrompt: `Measure the velocity of knowledge accumulation across different domains in my graph. Analyze: which topics are growing fastest (new entities per day), which have plateaued, where the deepest understanding exists (entity density + relationship richness), and which areas are accelerating or decelerating.`,
  },
  week_ahead: {
    name: 'Week Ahead',
    systemPrompt: `Based on my knowledge graph's current state, project what needs attention in the coming week. Analyze: pending actions and their deadlines, goals with upcoming milestones, risks that may materialize, people to follow up with, and topics requiring deeper exploration. Prioritize by impact and urgency.`,
  },
  strategic_arc: {
    name: 'Strategic Arc',
    systemPrompt: `Analyze the strategic arc of my knowledge over the past month. Identify: major theme shifts, goal progression patterns, strategic pivots evident in the data, long-term trends in what I'm learning and working on, and how my focus areas have evolved. Present as a narrative of strategic direction.`,
  },
  goal_trajectory: {
    name: 'Goal Trajectory',
    systemPrompt: `Evaluate the trajectory of all Goal entities in my knowledge graph. For each goal: assess progress based on connected actions and decisions, identify supporting and blocking factors, compare planned vs actual trajectory, and recommend course corrections if needed.`,
  },
  network_evolution: {
    name: 'Network Evolution',
    systemPrompt: `Analyze how my professional network has evolved over the past month. Identify: new people added, changing relationship strengths, network clusters forming or dissolving, key connectors, and people who bridge different domains. Highlight network health metrics.`,
  },
  knowledge_portfolio: {
    name: 'Knowledge Portfolio',
    systemPrompt: `Assess my knowledge portfolio balance. Analyze the distribution of: topics I'm investing in (entity density), areas with deep vs shallow understanding, knowledge domains that support my goals vs tangential areas, and gaps between my knowledge and my stated priorities.`,
  },
  hypothesis_review: {
    name: 'Hypothesis Review',
    systemPrompt: `Review all Hypothesis entities in my knowledge graph. For each: evaluate evidence for and against (connected entities and sources), assess confidence based on supporting data, identify what additional evidence would be needed, and flag hypotheses that should be promoted to confirmed Insights or abandoned.`,
  },
  monthly_priorities: {
    name: 'Monthly Priorities',
    systemPrompt: `Based on the month's full knowledge context, establish priorities for the coming month. Consider: goal trajectories, emerging themes, pending decisions, relationship dynamics, knowledge gaps, and strategic direction. Propose 5-7 priorities ranked by strategic importance.`,
  },
}

// ─── SIMPLIFIED RAG: embed query → semantic search → generate ─────────────────

async function runModuleRAG(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  modulePrompt: string,
  density: string
): Promise<{ content: string; sourceCount: number }> {
  // 1. Embed the module prompt
  const embedding = await embedText(modulePrompt.substring(0, 500))

  // 2. Semantic search over source chunks
  const { data: chunks } = await supabase.rpc('match_source_chunks', {
    query_embedding: embedding,
    match_threshold: 0.35,
    match_count: 12,
    p_user_id: userId,
  })

  // 3. Semantic search over knowledge nodes
  const { data: nodes } = await supabase.rpc('match_knowledge_nodes', {
    query_embedding: embedding,
    match_threshold: 0.35,
    match_count: 15,
    p_user_id: userId,
  })

  // 4. Build context
  const chunkContext = (chunks ?? [])
    .map((c: { content: string; source_title?: string }) =>
      `[Source: ${c.source_title ?? 'Unknown'}]\n${c.content}`)
    .join('\n\n')

  const nodeContext = (nodes ?? [])
    .map((n: { label: string; entity_type: string; description?: string }) =>
      `• ${n.entity_type}: ${n.label}${n.description ? ` — ${n.description}` : ''}`)
    .join('\n')

  const densityInstruction = DENSITY_INSTRUCTIONS[density] ?? DENSITY_INSTRUCTIONS.standard

  const systemPrompt = `You are an intelligence analyst for a personal knowledge graph. Synthesize the provided context to answer the user's query. Be specific, cite entities by name, and be actionable. ${densityInstruction}`

  const userPrompt = `## Knowledge Graph Entities\n${nodeContext || 'No entities found.'}\n\n## Source Documents\n${chunkContext || 'No source documents found.'}\n\n## Task\n${modulePrompt}`

  // 5. Generate with Gemini
  const content = await generateWithGemini(systemPrompt, userPrompt)
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
    <!-- Header -->
    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #d63a00;">Synapse</h1>
      <p style="margin: 4px 0 0; font-size: 12px; color: #9ca3af;">${date} · ${time}</p>
    </div>

    <!-- Card -->
    <div style="background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <!-- Title -->
      <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 700; color: #1a1a1a;">${title}</h2>

      <!-- Executive Summary -->
      <div style="margin-bottom: 24px; padding: 16px; background: #fff7ed; border-radius: 8px; border-left: 3px solid #d63a00;">
        <p style="margin: 0 0 4px 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #d63a00;">Executive Summary</p>
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #374151;">${executiveSummary}</p>
      </div>

      <!-- Modules -->
      ${moduleHTML}
    </div>

    <!-- Footer -->
    <div style="text-align: center; margin-top: 24px; padding: 16px;">
      <p style="margin: 0; font-size: 12px; color: #9ca3af;">
        Generated by <a href="https://connectsynapse.com" style="color: #d63a00; text-decoration: none;">Synapse</a> · Your personal knowledge graph
      </p>
      <p style="margin: 8px 0 0; font-size: 11px; color: #d1d5db;">
        You're receiving this because you enabled email digests in your Synapse settings.
      </p>
    </div>
  </div>
</body>
</html>`
}

// ─── SEND EMAIL VIA RESEND ────────────────────────────────────────────────────

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
      from: 'Synapse <digest@send.connectsynapse.com>',
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

// ─── CHECK IF PROFILE IS DUE ─────────────────────────────────────────────────

function isProfileDue(
  frequency: string,
  scheduleTime: string,
  scheduleTimezone: string,
  lastGeneratedAt: string | null,
  now: Date
): boolean {
  // Convert current time to user's timezone
  const userNow = new Date(now.toLocaleString('en-US', { timeZone: scheduleTimezone || 'UTC' }))
  const userHour = userNow.getHours()
  const userMinute = userNow.getMinutes()

  // Parse schedule time (HH:MM or HH:MM:SS)
  const [schedHour, schedMinute] = (scheduleTime || '09:00').split(':').map(Number)

  // Are we within the schedule window? (within 30 min after scheduled time)
  const schedMinutes = (schedHour ?? 9) * 60 + (schedMinute ?? 0)
  const currentMinutes = userHour * 60 + userMinute
  const inWindow = currentMinutes >= schedMinutes && currentMinutes < schedMinutes + 30

  if (!inWindow) return false

  // Has it already been generated today/this-week/this-month?
  if (lastGeneratedAt) {
    const lastGen = new Date(lastGeneratedAt)
    const hoursSince = (now.getTime() - lastGen.getTime()) / (1000 * 60 * 60)

    if (frequency === 'daily' && hoursSince < 20) return false
    if (frequency === 'weekly' && hoursSince < 144) return false // ~6 days
    if (frequency === 'monthly' && hoursSince < 672) return false // ~28 days
  }

  return true
}

// ─── HANDLER ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

  const startTime = Date.now()
  const sb = getSupabase()
  const now = new Date()

  const results: Array<{
    profileId: string; title: string; userId: string
    modules: number; status: string; emailSent?: boolean; error?: string
  }> = []

  try {
    // 1. Fetch all active digest profiles with their modules and channels
    const { data: profiles, error: profilesError } = await sb
      .from('digest_profiles')
      .select(`
        id, user_id, title, frequency, density, schedule_time, schedule_timezone, is_active,
        digest_modules ( id, template_id, sort_order, is_active, custom_context ),
        digest_channels ( id, channel_type, is_active, config, density_override )
      `)
      .eq('is_active', true)

    if (profilesError) throw new Error(`Failed to fetch profiles: ${profilesError.message}`)
    if (!profiles || profiles.length === 0) {
      return res.status(200).json({
        success: true, message: 'No active digest profiles', duration_ms: Date.now() - startTime,
      })
    }

    // 2. For each profile, check if it's due
    for (const profile of profiles) {
      const profileId = profile.id as string
      const userId = profile.user_id as string
      const title = profile.title as string
      const frequency = profile.frequency as string
      const density = (profile.density as string) || 'standard'
      const scheduleTime = (profile.schedule_time as string) || '09:00:00'
      const scheduleTimezone = (profile.schedule_timezone as string) || 'UTC'

      // Check last generation time
      const { data: lastHistory } = await sb
        .from('digest_history')
        .select('generated_at')
        .eq('digest_profile_id', profileId)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const lastGeneratedAt = (lastHistory?.generated_at as string) ?? null

      if (!isProfileDue(frequency, scheduleTime, scheduleTimezone, lastGeneratedAt, now)) {
        continue
      }

      console.log(`[generate-scheduled] Generating digest: "${title}" for user ${userId}`)

      try {
        // 3. Generate each module
        const modules = ((profile.digest_modules ?? []) as Array<{
          template_id: string; is_active: boolean; custom_context: string | null; sort_order: number
        }>)
          .filter(m => m.is_active)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

        const moduleOutputs: Array<{
          templateId: string; name: string; content: string
          sourceCount: number; durationMs: number; error?: string
        }> = []

        for (const mod of modules) {
          const moduleStart = Date.now()
          const templateId = mod.template_id as string

          // Custom agent modules
          if (templateId === 'custom_agent') {
            let customConfig: { name?: string; task?: string; behavior?: string; goal?: string; outputFormat?: string } = {}
            try { customConfig = JSON.parse(mod.custom_context ?? '{}') } catch { continue }
            if (!customConfig.task?.trim()) continue

            const moduleName = customConfig.name?.trim() || 'Custom Agent'
            try {
              let prompt = customConfig.task
              if (customConfig.behavior?.trim()) prompt += `\n\nApproach: ${customConfig.behavior}`
              if (customConfig.goal?.trim()) prompt += `\n\nGoal: ${customConfig.goal}`
              if (customConfig.outputFormat?.trim()) {
                prompt += `\n\nFormat your response exactly as follows: ${customConfig.outputFormat}.`
              }

              const result = await runModuleRAG(sb, userId, prompt, density)
              moduleOutputs.push({
                templateId, name: moduleName, content: result.content,
                sourceCount: result.sourceCount, durationMs: Date.now() - moduleStart,
              })
            } catch (err) {
              moduleOutputs.push({
                templateId, name: moduleName, content: '',
                sourceCount: 0, durationMs: Date.now() - moduleStart,
                error: err instanceof Error ? err.message : 'Unknown error',
              })
            }
            continue
          }

          // Standard template modules
          const template = TEMPLATES[templateId]
          if (!template) continue

          try {
            const result = await runModuleRAG(sb, userId, template.systemPrompt, density)
            moduleOutputs.push({
              templateId, name: template.name, content: result.content,
              sourceCount: result.sourceCount, durationMs: Date.now() - moduleStart,
            })
          } catch (err) {
            moduleOutputs.push({
              templateId, name: template.name, content: '',
              sourceCount: 0, durationMs: Date.now() - moduleStart,
              error: err instanceof Error ? err.message : 'Unknown error',
            })
          }
        }

        // 4. Generate executive summary
        let executiveSummary = ''
        const successfulModules = moduleOutputs.filter(m => !m.error)
        if (successfulModules.length > 0) {
          const summaryContext = successfulModules
            .map(m => `[${m.name}]: ${m.content}`)
            .join('\n\n')
          executiveSummary = await generateWithGemini(
            'You are a concise intelligence analyst. Write a 2-3 sentence executive summary.',
            `Given these intelligence module outputs, highlight the most important findings and cross-module patterns:\n\n${summaryContext}`
          )
        } else {
          executiveSummary = 'All modules encountered errors during generation.'
        }

        // 5. Save to digest_history
        const generatedAt = new Date().toISOString()
        const digestContent = {
          profileId, title, generatedAt, executiveSummary,
          modules: moduleOutputs.map(m => ({
            templateId: m.templateId, templateName: m.name,
            content: m.content, citations: [], relatedNodes: [],
            generationDurationMs: m.durationMs, error: m.error,
          })),
          totalDurationMs: Date.now() - startTime,
        }

        const deliveryResults: Array<{ channelType: string; success: boolean; error?: string; sentAt?: string }> = []

        // 6. Send email if channel is configured
        const emailChannels = ((profile.digest_channels ?? []) as Array<{
          channel_type: string; is_active: boolean; config: Record<string, string>
        }>).filter(c => c.channel_type === 'email' && c.is_active)

        for (const channel of emailChannels) {
          const emailAddress = channel.config?.email_address || channel.config?.address
          if (!emailAddress) {
            deliveryResults.push({
              channelType: 'email', success: false,
              error: 'No email address configured',
            })
            continue
          }

          const subject = `${title} — ${new Date(generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
          const html = renderDigestHTML(
            title, executiveSummary,
            moduleOutputs.map(m => ({ name: m.name, content: m.content, error: m.error })),
            generatedAt
          )

          const emailResult = await sendEmail(emailAddress, subject, html)
          deliveryResults.push({
            channelType: 'email',
            success: emailResult.success,
            error: emailResult.error,
            sentAt: emailResult.success ? new Date().toISOString() : undefined,
          })
        }

        // Save history
        await sb.from('digest_history').insert({
          digest_profile_id: profileId,
          user_id: userId,
          generated_at: generatedAt,
          content: digestContent,
          module_outputs: digestContent.modules,
          executive_summary: executiveSummary,
          density,
          generation_duration_ms: Date.now() - startTime,
          status: deliveryResults.some(d => d.success) ? 'delivered' : 'generated',
          delivery_results: deliveryResults,
        })

        const emailSent = deliveryResults.some(d => d.success)
        results.push({
          profileId, title, userId,
          modules: moduleOutputs.length, status: 'generated',
          emailSent,
        })

        console.log(
          `[generate-scheduled] Done: "${title}" modules=${moduleOutputs.length} ` +
          `email=${emailSent} duration=${Date.now() - startTime}ms`
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[generate-scheduled] Failed: "${title}"`, msg)
        results.push({ profileId, title, userId, modules: 0, status: 'failed', error: msg })
      }
    }

    return res.status(200).json({
      success: true,
      generated: results.length,
      results,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[generate-scheduled] Fatal error:', msg)
    return res.status(500).json({ success: false, error: msg, duration_ms: Date.now() - startTime })
  }
}
