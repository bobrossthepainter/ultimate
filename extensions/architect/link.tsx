import type { ConversationId } from '@earendil-works/pi-durable'
import { useEffect, useSyncExternalStore } from 'react'
import { useExtensionUiState, useUltimate } from '@/sdk'
import type { Part } from './parts.tsx'

export type View = { branch?: ConversationId; version?: number; diagram?: string; compare?: number }

export const useView = () => useExtensionUiState<View>('view', {})

export const useChatOpen = () => useExtensionUiState<boolean>('chat', false)

type Request = View & { mark?: Pick<Part, 'kind' | 'part'> }

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const notify = () => {
  for (const listener of listeners) listener()
}

let requested: Request | undefined
let marked: Request['mark']

export function openArchitecture(place: Request) {
  requested = place
  notify()
}

export const useMark = () => useSyncExternalStore(subscribe, () => marked)
export function clearMark() {
  if (!marked) return
  marked = undefined
  notify()
}

export function ArchitectureLink() {
  const wanted = useSyncExternalStore(subscribe, () => requested)
  const [, setView] = useView()
  const { showSurface } = useUltimate()
  useEffect(() => {
    if (wanted === undefined) return
    requested = undefined
    const { mark, ...view } = wanted
    marked = mark
    setView(view)
    showSurface('architecture')
    notify()
  }, [wanted, setView, showSurface])
  return null
}
