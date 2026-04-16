import { useState, useCallback } from 'react'
import { useSettings } from '../../hooks/useSettings'
import { Step0Walkthrough } from './Step0Walkthrough'
import { Step1ImportHistory } from './Step1ImportHistory'
import { Step2ReviewProfile } from './Step2ReviewProfile'
import { Step3ConnectMeetings } from './Step3ConnectMeetings'
import { Step4ConnectYouTube } from './Step4ConnectYouTube'

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
        <Step1ImportHistory
          onNext={(completed) => handleNext(1, { step1Completed: completed })}
          onSkipAll={handleSkipAll}
        />
      )
    case 2:
      return (
        <Step2ReviewProfile
          onNext={() => handleNext(2)}
          onSkipAll={handleSkipAll}
        />
      )
    case 3:
      return (
        <Step3ConnectMeetings
          onNext={() => handleNext(3)}
          onSkipAll={handleSkipAll}
        />
      )
    case 4:
      return (
        <Step4ConnectYouTube
          onFinish={() => handleNext(4)}
          onSkipAll={handleSkipAll}
        />
      )
  }
}
