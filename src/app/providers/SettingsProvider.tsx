import { createContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import {
  fetchOrCreateProfile,
  fetchOrCreateExtractionSettings,
  updateProfile as updateProfileService,
  updateExtractionSettings as updateExtractionSettingsService,
  promoteToAnchor as promoteToAnchorService,
  demoteAnchor as demoteAnchorService,
  completeOnboarding as completeOnboardingService,
  resetOnboarding as resetOnboardingService,
  supabase,
} from '../../services/supabase'
import type { KnowledgeNode, UserProfile, ExtractionSettings } from '../../types/database'

type ProfileUpdates = Partial<{
  professional_context: Record<string, string>
  personal_interests: Record<string, string>
  processing_preferences: Record<string, string>
}>

export interface SettingsContextValue {
  // Read
  profile: UserProfile | null
  extractionSettings: ExtractionSettings | null
  anchors: KnowledgeNode[]
  loading: boolean

  // Write
  updateProfile: (updates: ProfileUpdates) => Promise<{ error: Error | null }>
  updateExtractionSettings: (updates: Partial<{ default_mode: string; default_anchor_emphasis: string }>) => Promise<{ error: Error | null }>
  promoteToAnchor: (nodeId: string) => Promise<{ error: Error | null }>
  demoteAnchor: (nodeId: string) => Promise<{ error: Error | null }>
  completeOnboarding: () => Promise<{ error: Error | null }>
  resetOnboarding: () => Promise<{ error: Error | null }>

  // Refresh
  refreshAnchors: () => Promise<void>
  refreshProfile: () => Promise<void>
  refreshExtractionSettings: () => Promise<void>
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [extractionSettings, setExtractionSettings] = useState<ExtractionSettings | null>(null)
  const [anchors, setAnchors] = useState<KnowledgeNode[]>([])
  const [loading, setLoading] = useState(true)

  const refreshAnchors = useCallback(async () => {
    const { data } = await supabase
      .from('knowledge_nodes')
      .select('*')
      .eq('is_anchor', true)
      .order('label')
    if (data) setAnchors(data as KnowledgeNode[])
  }, [])

  const refreshProfile = useCallback(async () => {
    const data = await fetchOrCreateProfile()
    if (data) setProfile(data)
  }, [])

  const refreshExtractionSettings = useCallback(async () => {
    const data = await fetchOrCreateExtractionSettings()
    if (data) setExtractionSettings(data)
  }, [])

  const updateProfileFn = useCallback(async (updates: ProfileUpdates) => {
    const result = await updateProfileService(updates)
    if (!result.error) {
      setProfile(prev =>
        prev ? { ...prev, ...updates } as UserProfile : null
      )
    }
    return result
  }, [])

  const updateExtractionSettingsFn = useCallback(async (
    updates: Partial<{ default_mode: string; default_anchor_emphasis: string }>
  ) => {
    const result = await updateExtractionSettingsService(updates)
    if (!result.error) {
      setExtractionSettings(prev =>
        prev ? { ...prev, ...updates } as ExtractionSettings : null
      )
    }
    return result
  }, [])

  const promoteToAnchorFn = useCallback(async (nodeId: string) => {
    const result = await promoteToAnchorService(nodeId)
    if (!result.error) await refreshAnchors()
    return result
  }, [refreshAnchors])

  const demoteAnchorFn = useCallback(async (nodeId: string) => {
    const result = await demoteAnchorService(nodeId)
    if (!result.error) await refreshAnchors()
    return result
  }, [refreshAnchors])

  const completeOnboardingFn = useCallback(async () => {
    const result = await completeOnboardingService()
    if (!result.error) {
      setProfile(prev =>
        prev ? { ...prev, onboarding_complete: true } as UserProfile : null
      )
    }
    return result
  }, [])

  const resetOnboardingFn = useCallback(async () => {
    const result = await resetOnboardingService()
    if (!result.error) {
      setProfile(prev =>
        prev ? { ...prev, onboarding_complete: false } as UserProfile : null
      )
    }
    return result
  }, [])

  useEffect(() => {
    Promise.all([
      refreshProfile(),
      refreshExtractionSettings(),
      refreshAnchors(),
    ]).finally(() => setLoading(false))
  }, [refreshProfile, refreshExtractionSettings, refreshAnchors])

  return (
    <SettingsContext.Provider value={{
      profile,
      extractionSettings,
      anchors,
      loading,
      updateProfile: updateProfileFn,
      updateExtractionSettings: updateExtractionSettingsFn,
      promoteToAnchor: promoteToAnchorFn,
      demoteAnchor: demoteAnchorFn,
      completeOnboarding: completeOnboardingFn,
      resetOnboarding: resetOnboardingFn,
      refreshAnchors,
      refreshProfile,
      refreshExtractionSettings,
    }}>
      {children}
    </SettingsContext.Provider>
  )
}
