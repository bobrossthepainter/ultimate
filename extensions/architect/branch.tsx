import type { ConversationId } from '@earendil-works/pi-durable'
import { getState, ROOT, useConversations, useDocOf } from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import { getRoots, useRoots } from '../lineage/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'

export function branchOf(summary: ConversationSummary | undefined, id: ConversationId) {
  return summary?.label === 'architect' && summary.parentConversationId !== undefined
    ? summary.parentConversationId
    : id
}

function notDrawable(
  id: ConversationId,
  conversations: readonly ConversationSummary[],
  roots: readonly number[],
  standing: Record<string, number>,
) {
  const summary = conversations.find((conversation) => conversation.id === id)
  if (!summary) return 'Not a conversation'
  if (summary.parentConversationId !== undefined) return 'A subagent has no branch to draw'
  if (roots.includes(id)) return 'A root has no branch to draw'
  const agent = Object.entries(standing).find(([, conversation]) => conversation === id)?.[0]
  if (agent) return `@${agent} is a standing agent, not a branch`
  if (summary.label === 'lander') return 'The lander is not a branch'
  return undefined
}

export function useNotDrawable() {
  const conversations = useConversations()
  const roots = useRoots() ?? [ROOT]
  const standing = useDocOf(ROOT, StandingDoc) ?? {}
  return (id: ConversationId) => notDrawable(id, conversations, roots, standing)
}

export function drawableBranchNow(id: ConversationId) {
  const state = getState()
  const branch = branchOf(
    state.conversations.find((conversation) => conversation.id === id),
    id,
  )
  const standing = (state.docsOf[ROOT]?.[StandingDoc.kind] ?? {}) as Record<string, number>
  return notDrawable(branch, state.conversations, getRoots() ?? [ROOT], standing)
    ? undefined
    : branch
}
