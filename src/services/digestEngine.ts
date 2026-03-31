import { queryGraph } from './rag'
import { generateText } from './gemini'
import { fetchDigestHistory } from './supabase'
import { getTemplateById } from '../config/digestTemplates'
import type { DigestProfile } from '../types/feed'
import type { DigestOutput, ModuleOutput } from '../types/digest'
import type { QueryConfig } from '../types/rag'

const DENSITY_INSTRUCTIONS: Record<string, string> = {
  brief: 'Respond in 2–3 sentences. Focus on the single most important finding only.',
  standard: 'Respond in 1–2 paragraphs. Cover key findings with enough context to be actionable.',
  comprehensive: 'Provide detailed analysis in 3–4 paragraphs. Include supporting evidence, related entities, and specific recommendations.',
}

/** Max concurrent module generations to avoid Gemini rate limits */
const MAX_CONCURRENCY = 3

/**
 * Runs async tasks with a concurrency limit.
 * Returns results in the same order as the input tasks.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      const task = tasks[idx]
      if (task) results[idx] = await task()
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext())
  await Promise.all(workers)
  return results
}

/** QueryConfig overrides for digest modules — skips classification and decomposition */
const DIGEST_QUERY_CONFIG: QueryConfig = {
  mindset: 'analytical',
  scopeAnchors: [],
  toolMode: 'deep',
  modelTier: 'thorough',
  skipClassification: true,
  skipDecomposition: true,
}

export async function generateDigest(
  profile: DigestProfile,
  userId: string,
  options?: {
    densityOverride?: string
    onModuleProgress?: (current: number, total: number, name: string) => void
  }
): Promise<DigestOutput> {
  const startTime = Date.now()
  const density = options?.densityOverride ?? profile.density ?? 'standard'
  const activeModules = profile.modules.filter(m => m.isActive)

  // Load recent history for deduplication context
  let recentThemes = ''
  try {
    const recentHistory = await fetchDigestHistory(profile.id, 3)
    recentThemes = recentHistory
      .map(h => h.executive_summary)
      .filter(Boolean)
      .join(' ')
      .substring(0, 500)
  } catch {
    // Not critical — continue without deduplication context
  }

  // ─── Build module generation tasks ──────────────────────────────────────────
  let completedCount = 0

  const tasks = activeModules.map((mod, _i) => {
    return async (): Promise<ModuleOutput> => {
      // ── Custom agent module ────────────────────────────────────────────────
      if (mod.templateId === 'custom_agent') {
        let customConfig: { name?: string; task?: string; behavior?: string; goal?: string; outputFormat?: string } = {}
        try { customConfig = JSON.parse(mod.customContext ?? '{}') } catch {
          return {
            templateId: mod.templateId,
            templateName: 'Custom Agent',
            content: 'This module has an invalid configuration.',
            citations: [],
            relatedNodes: [],
            generationDurationMs: 0,
            error: 'Invalid custom_context JSON',
          }
        }
        if (!customConfig.task?.trim()) {
          return {
            templateId: mod.templateId,
            templateName: customConfig.name?.trim() || 'Custom Agent',
            content: 'This module has no task configured.',
            citations: [],
            relatedNodes: [],
            generationDurationMs: 0,
            error: 'No task configured',
          }
        }

        const moduleName = customConfig.name?.trim() || 'Custom Agent'
        completedCount++
        options?.onModuleProgress?.(completedCount, activeModules.length, moduleName)
        const moduleStart = Date.now()

        try {
          let query = customConfig.task
          if (customConfig.behavior?.trim()) query += `\n\nApproach: ${customConfig.behavior}`
          if (customConfig.goal?.trim()) query += `\n\nGoal: ${customConfig.goal}`
          if (customConfig.outputFormat?.trim()) {
            query += `\n\nFormat your response exactly as follows: ${customConfig.outputFormat}. Preserve this format precisely — do not wrap it in standard module headings or additional structure.`
          }
          const densityInstruction = DENSITY_INSTRUCTIONS[density] ?? DENSITY_INSTRUCTIONS.standard
          query += `\n\n${densityInstruction}`
          if (recentThemes) {
            query += `\n\nRecent digest themes (avoid repetition, focus on new developments): ${recentThemes}`
          }

          const result = await queryGraph(query, userId, [], DIGEST_QUERY_CONFIG)
          return {
            templateId: mod.templateId,
            templateName: moduleName,
            content: result.answer,
            citations: result.citations,
            relatedNodes: result.relatedNodes,
            generationDurationMs: Date.now() - moduleStart,
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          return {
            templateId: mod.templateId,
            templateName: moduleName,
            content: 'This module encountered an error during generation.',
            citations: [],
            relatedNodes: [],
            generationDurationMs: Date.now() - moduleStart,
            error: message,
          }
        }
      }

      // ── Standard template module ─────────────────────────────────────────────
      const template = getTemplateById(mod.templateId)
      if (!template) {
        return {
          templateId: mod.templateId,
          templateName: mod.templateId,
          content: 'Unknown template.',
          citations: [],
          relatedNodes: [],
          generationDurationMs: 0,
          error: `Template not found: ${mod.templateId}`,
        }
      }

      completedCount++
      options?.onModuleProgress?.(completedCount, activeModules.length, template.name)
      const moduleStart = Date.now()

      try {
        let query = template.systemPrompt
        const densityInstruction = DENSITY_INSTRUCTIONS[density] ?? DENSITY_INSTRUCTIONS.standard
        query += `\n\n${densityInstruction}`
        if (recentThemes) {
          query += `\n\nRecent digest themes (avoid repetition, focus on new developments): ${recentThemes}`
        }

        const result = await queryGraph(query, userId, [], DIGEST_QUERY_CONFIG)
        return {
          templateId: mod.templateId,
          templateName: template.name,
          content: result.answer,
          citations: result.citations,
          relatedNodes: result.relatedNodes,
          generationDurationMs: Date.now() - moduleStart,
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return {
          templateId: mod.templateId,
          templateName: template.name,
          content: 'This module encountered an error during generation.',
          citations: [],
          relatedNodes: [],
          generationDurationMs: Date.now() - moduleStart,
          error: message,
        }
      }
    }
  })

  // ─── Execute modules with concurrency limit ────────────────────────────────
  const moduleOutputs = await runWithConcurrency(tasks, MAX_CONCURRENCY)

  // ─── Generate executive summary (direct Gemini call — no RAG needed) ───────
  let executiveSummary = ''
  const successfulModules = moduleOutputs.filter(m => !m.error)

  if (successfulModules.length > 0) {
    options?.onModuleProgress?.(activeModules.length, activeModules.length, 'Executive Summary')
    try {
      const summaryContext = successfulModules
        .map(m => `## ${m.templateName}\n${m.content}`)
        .join('\n\n---\n\n')

      const systemPrompt = `You are a senior intelligence analyst synthesising a personal knowledge briefing. Your role is to transform individual module outputs into a cohesive executive overview that is MORE valuable than the sum of its parts.

Your synthesis must:
1. CONNECT cross-module patterns — identify themes, tensions, or opportunities that span multiple modules but that no single module surfaced
2. PRIORITISE strategically — lead with the highest-impact insight, not a generic summary
3. SURFACE actionable implications — what should the reader do, investigate, or watch based on the combined intelligence?
4. PRESERVE specificity — reference concrete entities, projects, people, and data points by name. Never flatten rich findings into vague generalities

Format your response as:
**Key Insight:** [One powerful sentence capturing the most important cross-module finding]

**Strategic Context:** [2-3 sentences connecting the dots across modules — what patterns emerge when you look at these findings together?]

**Action Items:**
- [Specific, actionable item derived from the combined intelligence]
- [Another action item if warranted]

**Watch List:** [1-2 sentences on emerging signals or risks worth monitoring]

Keep the total response under 250 words. Every sentence must earn its place by adding insight beyond what the individual modules already stated.`

      executiveSummary = await generateText(
        systemPrompt,
        `Here are the intelligence module outputs from my knowledge graph. Synthesise them into a strategic executive overview:\n\n${summaryContext}`,
        { temperature: 0.4, maxOutputTokens: 2048 }
      )
    } catch {
      executiveSummary = 'Executive summary generation failed. Review individual modules below.'
    }
  } else {
    executiveSummary = 'All modules encountered errors. Check that your knowledge graph has sufficient data.'
  }

  return {
    profileId: profile.id,
    title: profile.title,
    generatedAt: new Date().toISOString(),
    executiveSummary,
    modules: moduleOutputs,
    totalDurationMs: Date.now() - startTime,
  }
}
