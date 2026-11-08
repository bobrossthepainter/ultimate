/** Pending feedback on a version, kept on the branch (`architect.drafts`): the surface and the architecture chat edit it. */
import { useCallback } from 'react'
import { api, useDocOf } from '@/sdk'
import { DraftsDoc, EditAction } from './refs.ts'
import type { ArchitectureComment, DraftEdit, Drafts } from './refs.ts'

export type { Draft, Drafts } from './refs.ts'

/** What `edit` and `send` accept (server.ts). */
export const limits = { comments: 50, text: 4000 } as const

const empty: Drafts = { comments: [], note: '' }

/** The pending feedback on `version` of `branch`, and `edit`, which changes it on the server and returns the result. */
export function useDrafts(branch: number, version: number) {
  const doc = useDocOf(branch, DraftsDoc)
  const drafts = doc?.versions[String(version)] ?? empty
  const edit = useCallback(
    (change: DraftEdit) => api.action(EditAction, { branch, version, edit: change }),
    [branch, version],
  )
  return [drafts, edit] as const
}

/** What a comment is on, as a short mono label: `node surface`, `edge a → b: label`, or the diagram. */
export const where = (comment: Pick<ArchitectureComment, 'kind' | 'part' | 'label'>) =>
  comment.kind === 'diagram'
    ? 'diagram'
    : // An edge's ID (`L_a_b_0`) means little to a reader; its label is its route.
      `${comment.kind} ${comment.kind === 'edge' ? comment.label : comment.part}`
