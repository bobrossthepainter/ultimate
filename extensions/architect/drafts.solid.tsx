/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { api, useDocOf } from '@/sdk/solid'
import { DraftsDoc, EditAction } from './refs.ts'
import type { ArchitectureComment, DraftEdit, Drafts } from './refs.ts'

export type { Draft, Drafts } from './refs.ts'

export const limits = { comments: 50, text: 4000 } as const

const empty: Drafts = { comments: [], note: '' }

export function useDrafts(branch: Accessor<ConversationId>, version: Accessor<number>) {
  const doc = useDocOf(branch, DraftsDoc)
  const drafts = () => doc()?.versions[String(version())] ?? empty
  const edit = (change: DraftEdit) =>
    api.action(EditAction, { branch: branch(), version: version(), edit: change })
  return [drafts, edit] as const
}

export const where = (comment: Pick<ArchitectureComment, 'kind' | 'part' | 'label'>) =>
  comment.kind === 'diagram'
    ? 'diagram'
    : `${comment.kind} ${comment.kind === 'edge' ? comment.label : comment.part}`
