import type { ConversationId } from '@earendil-works/pi-durable'
import { useCallback } from 'react'
import { api, useDocOf } from '@/sdk'
import { DraftsDoc, EditAction } from './refs.ts'
import type { ArchitectureComment, DraftEdit, Drafts } from './refs.ts'

export type { Draft, Drafts } from './refs.ts'

export const limits = { comments: 50, text: 4000 } as const

const empty: Drafts = { comments: [], note: '' }

export function useDrafts(branch: ConversationId, version: number) {
  const doc = useDocOf(branch, DraftsDoc)
  const drafts = doc?.versions[String(version)] ?? empty
  const edit = useCallback(
    (change: DraftEdit) => api.action(EditAction, { branch, version, edit: change }),
    [branch, version],
  )
  return [drafts, edit] as const
}

export const where = (comment: Pick<ArchitectureComment, 'kind' | 'part' | 'label'>) =>
  comment.kind === 'diagram'
    ? 'diagram'
    : `${comment.kind} ${comment.kind === 'edge' ? comment.label : comment.part}`
