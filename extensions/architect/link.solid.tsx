/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { cell } from '../../lib/cell.ts'
import { events, showSurface, useEvent, useExtensionUiState, useExternal } from '@/sdk/solid'
import type { Part } from './parts.solid.tsx'

export type View = { branch?: ConversationId; version?: number; diagram?: string; compare?: number }

export const useView = () => useExtensionUiState<View>('view', {})

export const useChatOpen = () => useExtensionUiState<boolean>('chat', false)

type Request = View & { mark?: Pick<Part, 'kind' | 'part'> }

const marked = cell<Request['mark']>(undefined)

export function openArchitecture(place: Request) {
  events.emit('architect:open', place)
}

export const useMark = () => useExternal(marked.get, marked.subscribe)

export function clearMark() {
  marked.set(undefined)
}

export function ArchitectureLink() {
  const [, setView] = useView()
  useEvent('architect:open', (request) => {
    const { mark, ...view } = request as Request
    marked.set(mark)
    setView(view)
    showSurface('architecture')
  })
  return null
}
