import { createContext, useCallback, useContext, useState } from 'react'

export interface ProcessingItem {
  id: string
  type: 'skill' | 'anchor'
  title?: string
}

interface ProcessingContextValue {
  items: ProcessingItem[]
  add: (item: ProcessingItem) => void
  remove: (id: string) => void
}

const ProcessingContext = createContext<ProcessingContextValue>({
  items: [],
  add: () => {},
  remove: () => {},
})

export function ProcessingProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ProcessingItem[]>([])

  const add = useCallback((item: ProcessingItem) => {
    setItems(prev => [...prev, item])
  }, [])

  const remove = useCallback((id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
  }, [])

  return (
    <ProcessingContext.Provider value={{ items, add, remove }}>
      {children}
    </ProcessingContext.Provider>
  )
}

export function useProcessingItems() {
  return useContext(ProcessingContext)
}
