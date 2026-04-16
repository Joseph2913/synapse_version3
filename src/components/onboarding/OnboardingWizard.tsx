import { useState, useCallback } from 'react'
import { useSettings } from '../../hooks/useSettings'

type OnboardingStep = 0 | 1 | 2 | 3 | 4

interface StepResult {
  step1Completed?: boolean
}

export function OnboardingWizard() {
  const { completeOnboarding, refreshProfile } = useSettings()
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(0)
  const [stepResults, setStepResults] = useState<StepResult>({})

  const handleSkipAll = useCallback(async () => {
    await completeOnboarding()
    await refreshProfile()
  }, [completeOnboarding, refreshProfile])

  const handleFinish = useCallback(async () => {
    await completeOnboarding()
    await refreshProfile()
  }, [completeOnboarding, refreshProfile])

  const handleNext = useCallback((fromStep: OnboardingStep, result?: Partial<StepResult>) => {
    if (result) {
      setStepResults(prev => ({ ...prev, ...result }))
    }

    switch (fromStep) {
      case 0:
        setCurrentStep(1)
        break
      case 1:
        if (result?.step1Completed) {
          setCurrentStep(2)
        } else {
          setCurrentStep(3)
        }
        break
      case 2:
        setCurrentStep(3)
        break
      case 3:
        setCurrentStep(4)
        break
      case 4:
        handleFinish()
        break
    }
  }, [handleFinish])

  // Suppress unused variable warning for stepResults until step components are added
  void stepResults

  // Placeholder UI - step components will be added in later tasks
  return (
    <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 overflow-hidden">
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-[var(--color-text-primary)] font-display font-bold text-xl mb-4">
            Onboarding Step {currentStep}
          </p>
          <button
            onClick={() => handleNext(currentStep, currentStep === 1 ? { step1Completed: false } : undefined)}
            className="px-6 py-2 rounded-full bg-[var(--color-accent-500)] text-white font-semibold text-sm mr-3"
          >
            Next
          </button>
          <button
            onClick={handleSkipAll}
            className="px-6 py-2 rounded-full border border-[var(--border-default)] text-[var(--color-text-secondary)] font-semibold text-sm"
          >
            Skip Onboarding
          </button>
        </div>
      </div>
    </div>
  )
}
