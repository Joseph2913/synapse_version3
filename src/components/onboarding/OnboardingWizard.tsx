import { useState, useCallback } from 'react'
import { useSettings } from '../../hooks/useSettings'
import { Step0Walkthrough } from './Step0Walkthrough'

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

  switch (currentStep) {
    case 0:
      return (
        <Step0Walkthrough
          onComplete={() => handleNext(0)}
          onSkipAll={handleSkipAll}
        />
      )
    case 1:
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <div className="text-center">
            <p className="font-display font-bold text-lg text-[var(--color-text-primary)] mb-4">
              Step 1: Import History
            </p>
            <button
              onClick={() => handleNext(1, { step1Completed: false })}
              className="px-5 py-2 rounded-full bg-[var(--color-accent-500)] text-white text-sm font-semibold mr-2"
            >
              Skip to Step 3
            </button>
            <button
              onClick={handleSkipAll}
              className="px-5 py-2 rounded-full border border-[var(--border-default)] text-[var(--color-text-secondary)] text-sm font-semibold"
            >
              Skip All
            </button>
          </div>
        </div>
      )
    case 2:
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <div className="text-center">
            <p className="font-display font-bold text-lg text-[var(--color-text-primary)] mb-4">
              Step 2: Connect Sources
            </p>
            <button
              onClick={() => handleNext(2)}
              className="px-5 py-2 rounded-full bg-[var(--color-accent-500)] text-white text-sm font-semibold mr-2"
            >
              Next
            </button>
            <button
              onClick={handleSkipAll}
              className="px-5 py-2 rounded-full border border-[var(--border-default)] text-[var(--color-text-secondary)] text-sm font-semibold"
            >
              Skip All
            </button>
          </div>
        </div>
      )
    case 3:
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <div className="text-center">
            <p className="font-display font-bold text-lg text-[var(--color-text-primary)] mb-4">
              Step 3: Set Up Profile
            </p>
            <button
              onClick={() => handleNext(3)}
              className="px-5 py-2 rounded-full bg-[var(--color-accent-500)] text-white text-sm font-semibold mr-2"
            >
              Next
            </button>
            <button
              onClick={handleSkipAll}
              className="px-5 py-2 rounded-full border border-[var(--border-default)] text-[var(--color-text-secondary)] text-sm font-semibold"
            >
              Skip All
            </button>
          </div>
        </div>
      )
    case 4:
      return (
        <div className="fixed inset-0 bg-[var(--color-bg-content)] z-50 flex items-center justify-center">
          <div className="text-center">
            <p className="font-display font-bold text-lg text-[var(--color-text-primary)] mb-4">
              Step 4: You&apos;re Ready
            </p>
            <button
              onClick={() => handleNext(4)}
              className="px-5 py-2 rounded-full bg-[var(--color-accent-500)] text-white text-sm font-semibold mr-2"
            >
              Enter Synapse
            </button>
            <button
              onClick={handleSkipAll}
              className="px-5 py-2 rounded-full border border-[var(--border-default)] text-[var(--color-text-secondary)] text-sm font-semibold"
            >
              Skip All
            </button>
          </div>
        </div>
      )
  }
}
