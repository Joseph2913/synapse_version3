import { useState, useRef, useCallback } from 'react'
import { Upload, FileText, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import { OnboardingStepLayout } from './OnboardingStepLayout'

interface Step1ImportHistoryProps {
  onNext: (completed: boolean) => void
  onSkipAll: () => void
}

type Platform = 'chatgpt' | 'claude'
type UploadStatus = 'idle' | 'selected' | 'processing' | 'complete' | 'error'

interface SelectedFile {
  file: File
  name: string
  size: string
}

const CHATGPT_INSTRUCTIONS = [
  'Go to Settings > Data Controls > Export Data',
  'Click Export to request your data',
  'Download the ZIP file from the email link',
  'Upload the conversations.json file from the ZIP',
]

const CLAUDE_INSTRUCTIONS = [
  'Go to Settings > Account > Export Data',
  'Click Export to request your data',
  'Download the ZIP file from the email link',
  'Upload the ZIP file directly',
]

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function Step1ImportHistory({ onNext, onSkipAll }: Step1ImportHistoryProps) {
  const [platform, setPlatform] = useState<Platform>('chatgpt')
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const acceptedType = platform === 'chatgpt' ? '.json' : '.zip'

  const handleFileSelect = useCallback((file: File) => {
    setErrorMessage('')
    setSelectedFile({
      file,
      name: file.name,
      size: formatFileSize(file.size),
    })
    setStatus('selected')
  }, [])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFileSelect(file)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleDropZoneClick = () => {
    if (status === 'processing' || status === 'complete') return
    fileInputRef.current?.click()
  }

  const handlePlatformSwitch = (p: Platform) => {
    setPlatform(p)
    setStatus('idle')
    setSelectedFile(null)
    setErrorMessage('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const pollForCompletion = async (jobId: string) => {
    const maxAttempts = 30
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      try {
        const res = await fetch(`/api/onboarding/process-export?jobId=${jobId}`)
        const data = (await res.json()) as { status: string }
        if (data.status === 'complete') {
          setStatus('complete')
          return
        }
        if (data.status === 'error') {
          throw new Error('Processing failed')
        }
      } catch {
        throw new Error('Failed to check processing status')
      }
    }
    throw new Error('Processing timed out')
  }

  const handleProcess = async () => {
    if (!selectedFile) return
    setStatus('processing')
    setErrorMessage('')

    try {
      const formData = new FormData()
      formData.append('file', selectedFile.file)
      formData.append('platform', platform)

      const res = await fetch('/api/onboarding/process-export', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? 'Upload failed')
      }

      const data = (await res.json()) as { jobId?: string; status?: string }

      if (data.status === 'complete') {
        setStatus('complete')
        return
      }

      if (data.jobId) {
        await pollForCompletion(data.jobId)
      } else {
        setStatus('complete')
      }
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  const handleNext = () => {
    if (status === 'complete') {
      onNext(true)
    } else if (status === 'selected') {
      void handleProcess()
    }
  }

  const isNextDisabled =
    (status === 'idle') ||
    (status === 'processing')

  const nextLabel =
    status === 'complete'
      ? 'Continue'
      : status === 'processing'
      ? 'Processing...'
      : 'Process & Continue'

  const instructions = platform === 'chatgpt' ? CHATGPT_INSTRUCTIONS : CLAUDE_INSTRUCTIONS

  return (
    <OnboardingStepLayout
      stepNumber={1}
      totalSteps={4}
      title="Import Your AI History"
      subtitle="Upload your ChatGPT or Claude conversation export. Synapse will analyze your conversations to build a profile of your interests and seed your knowledge graph."
      maxWidth={600}
      onSkipAll={onSkipAll}
      onSkip={() => onNext(false)}
      onNext={handleNext}
      nextLabel={nextLabel}
      skipLabel="Skip for now"
      nextDisabled={isNextDisabled}
    >
      {/* Platform tabs */}
      <div
        className="flex"
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: 20,
        }}
      >
        {(['chatgpt', 'claude'] as Platform[]).map((p) => {
          const isActive = platform === p
          return (
            <button
              key={p}
              onClick={() => handlePlatformSwitch(p)}
              className="font-body font-semibold transition-colors duration-150"
              style={{
                fontSize: 13,
                padding: '8px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: isActive
                  ? '2px solid var(--color-accent-500)'
                  : '2px solid transparent',
                color: isActive
                  ? 'var(--color-accent-500)'
                  : 'var(--color-text-secondary)',
                cursor: 'pointer',
                marginBottom: -1,
              }}
            >
              {p === 'chatgpt' ? 'ChatGPT' : 'Claude'}
            </button>
          )
        })}
      </div>

      {/* Export instructions */}
      <div style={{ marginBottom: 20 }}>
        <p
          className="font-body font-semibold"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}
        >
          How to export your data:
        </p>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {instructions.map((step, i) => (
            <div key={i} className="flex items-start" style={{ gap: 10 }}>
              <div
                className="flex items-center justify-center flex-shrink-0 rounded-full font-body font-semibold"
                style={{
                  width: 20,
                  height: 20,
                  fontSize: 11,
                  background: 'var(--color-accent-50)',
                  color: 'var(--color-accent-500)',
                  marginTop: 1,
                }}
              >
                {i + 1}
              </div>
              <span
                className="font-body"
                style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: '1.4' }}
              >
                {step}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Drop zone */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptedType}
        onChange={handleInputChange}
        style={{ display: 'none' }}
      />

      {status === 'complete' ? (
        <div
          className="flex items-center"
          style={{
            gap: 10,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'rgba(34, 197, 94, 0.08)',
            border: '1px solid rgba(34, 197, 94, 0.2)',
            marginBottom: 12,
          }}
        >
          <CheckCircle2 size={18} style={{ color: 'rgb(22, 163, 74)', flexShrink: 0 }} />
          <span
            className="font-body font-semibold"
            style={{ fontSize: 13, color: 'rgb(22, 163, 74)' }}
          >
            Conversations analyzed successfully
          </span>
        </div>
      ) : (
        <div
          onClick={handleDropZoneClick}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className="flex flex-col items-center justify-center transition-colors duration-150"
          style={{
            padding: '28px 20px',
            borderRadius: 12,
            border:
              status === 'selected' || status === 'processing'
                ? '1px solid rgba(214,58,0,0.2)'
                : isDragging
                ? '2px dashed var(--color-accent-500)'
                : '2px dashed var(--border-subtle)',
            background:
              status === 'selected' || status === 'processing'
                ? 'var(--color-accent-50)'
                : isDragging
                ? 'var(--color-accent-50)'
                : 'transparent',
            cursor: status === 'processing' ? 'default' : 'pointer',
            marginBottom: 12,
            gap: 8,
          }}
        >
          {status === 'processing' ? (
            <>
              <Loader2
                size={28}
                className="animate-spin"
                style={{ color: 'var(--color-accent-500)' }}
              />
              <span
                className="font-body font-semibold"
                style={{ fontSize: 13, color: 'var(--color-accent-500)' }}
              >
                Analyzing your conversations...
              </span>
            </>
          ) : status === 'selected' && selectedFile ? (
            <>
              <FileText size={24} style={{ color: 'var(--color-accent-500)' }} />
              <span
                className="font-body font-semibold"
                style={{ fontSize: 13, color: 'var(--color-accent-500)' }}
              >
                {selectedFile.name}
              </span>
              <span
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
              >
                {selectedFile.size} — click to change file
              </span>
            </>
          ) : (
            <>
              <Upload size={24} style={{ color: 'var(--color-text-secondary)' }} />
              <span
                className="font-body font-semibold"
                style={{ fontSize: 13, color: 'var(--color-text-primary)' }}
              >
                {platform === 'chatgpt'
                  ? 'Drop conversations.json here'
                  : 'Drop your ZIP file here'}
              </span>
              <span
                className="font-body"
                style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
              >
                or click to browse
              </span>
            </>
          )}
        </div>
      )}

      {/* Error display */}
      {status === 'error' && errorMessage && (
        <div
          className="flex items-start"
          style={{
            gap: 10,
            padding: '12px 14px',
            borderRadius: 10,
            background: 'rgba(220, 38, 38, 0.06)',
            border: '1px solid rgba(220, 38, 38, 0.2)',
            marginBottom: 12,
          }}
        >
          <AlertCircle size={16} style={{ color: 'rgb(220, 38, 38)', flexShrink: 0, marginTop: 1 }} />
          <span
            className="font-body"
            style={{ fontSize: 13, color: 'rgb(185, 28, 28)', lineHeight: '1.4' }}
          >
            {errorMessage}
          </span>
        </div>
      )}

      {/* Privacy note */}
      <div
        className="flex items-start"
        style={{
          gap: 10,
          padding: '12px 14px',
          borderRadius: 10,
          background: 'var(--color-accent-50)',
          borderLeft: '3px solid var(--color-accent-500)',
          marginBottom: 4,
        }}
      >
        <span
          className="font-body"
          style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: '1.5' }}
        >
          Your raw conversations are never stored. Synapse only extracts topics, patterns, and entities.
        </span>
      </div>
    </OnboardingStepLayout>
  )
}
