import type { QuestionSide, SideChat, SideChatIndex } from './refs.ts'

interface MainSummary {
  label?: string
  title?: string
  ownerTaskId?: number
}

export function mainName(
  id: number | undefined,
  ultimate: number | undefined,
  summary: MainSummary | undefined,
) {
  if (id === undefined) return undefined
  if (id === ultimate) return '@ultimate'
  if (summary?.label === 'coordinator' && summary.ownerTaskId === undefined)
    return `#${id}${summary.title ? ` · ${summary.title}` : ''}`
  return undefined
}

export const shortName = (name: string) => (name === '@ultimate' ? name : 'the branch')

export interface TabKey {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
}

export function togglesSideMode(event: TabKey, where: { forkable: boolean; popup: boolean }) {
  return (
    event.key === 'Tab' &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    !where.popup &&
    where.forkable
  )
}

export const openSides = (index: SideChatIndex | undefined) =>
  (index?.sides ?? []).filter((side) => side.ended === undefined)

export const frontSide = (front: number | null, index: SideChatIndex | undefined) =>
  openSides(index).find((side) => side.id === front)

export const openQuestionSide = (sides: readonly QuestionSide[] | undefined, message: number) =>
  sides?.find((side) => side.question === message && side.ended === undefined)

export const contextSize = (tokens: number) =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

export type Ending = { ending?: 'discard' | 'inject'; error?: string }

export function createEndings(describe: (failure: unknown) => string) {
  const endingsBySideChat = new Map<number, Ending>()
  const listeners = new Set<() => void>()
  const idle: Ending = {}
  const set = (side: number, next: Ending) => {
    endingsBySideChat.set(side, next)
    for (const listener of listeners) listener()
  }
  return {
    get: (side: number) => endingsBySideChat.get(side) ?? idle,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async end(side: number, how: 'discard' | 'inject', call: () => Promise<unknown>) {
      set(side, { ending: how })
      try {
        await call()
        set(side, {})
      } catch (failure) {
        set(side, { error: describe(failure).replace(/^side-chat\/\w+: /, '') })
      }
    },
  }
}

export function endings(side: Partial<SideChat> | undefined) {
  const live = side?.of !== undefined && side.ended === undefined
  return { inject: live, discard: live && !side.effects, locked: live && !!side.effects }
}
