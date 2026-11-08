import { useEffect, useSyncExternalStore } from 'react'
import { useExtensionUiState, useUltimate } from '@/sdk'
import type { Part } from './parts.tsx'

/**
 * What the surface shows, in durable UI state: a branch (else the default one), a version (else the latest), a
 * diagram (else the first) and a version to compare with.
 */
export type View = { branch?: number; version?: number; diagram?: string; compare?: number }

export const useView = () => useExtensionUiState<View>('view', {})

/** Whether the architecture chat is open beside the diagrams. */
export const useChatOpen = () => useExtensionUiState<boolean>('chat', false)

/** A request to show the surface at a place: from a comment card's chip or a command. */
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
// The part to mark once its diagram is on screen, until the user clicks elsewhere.
let marked: Request['mark']

/** Show the Architecture surface at `place`: a branch, and optionally its version, diagram and a part to mark. */
export function openArchitecture(place: Request) {
  requested = place
  notify()
}

/** The part a link asked to mark, until `clearMark`. */
export const useMark = () => useSyncExternalStore(subscribe, () => marked)
export function clearMark() {
  if (!marked) return
  marked = undefined
  notify()
}

/** Mounted at the root: shows a requested place, as Review's link does. */
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
