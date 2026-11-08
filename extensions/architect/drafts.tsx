/** Draft comments on a version in durable UI state: kept across reloads and shared by every tab, per branch and version. */
import { useCallback } from 'react'
import type { JsonValue } from '@/sdk'
import { useExtensionUiState } from '@/sdk'
import type { ArchitectureComment } from './refs.ts'

/** A comment not sent yet; `id` tells drafts on the same part apart. */
export type Draft = ArchitectureComment & { id: string }
/** A version's pending feedback: its comments, the overall note, and the recipient the user picked, if any. */
export type Drafts = { comments: Draft[]; note: string; to?: number }

/** What `send` takes (refs.ts), and how large drafts may grow: all UI state shares one 256 KiB document. */
export const limits = { comments: 50, text: 4000, drafts: 64 * 1024 } as const

const empty: Drafts = { comments: [], note: '' }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

export const newId = () =>
  // randomUUID needs a secure context; plain-HTTP network access is not one.
  crypto.getRandomValues(new Uint32Array(4)).join('-')

/**
 * The drafts on `version` of `branch`, and an updater that stores them at once. It returns false and stores nothing
 * when a change that grows them would not fit `limits.drafts`, so the caller keeps the text on screen.
 */
export function useDrafts(branch: number, version: number) {
  const [stored, set] = useExtensionUiState<JsonValue>(`drafts:${branch}:${version}`, null)
  const drafts = (stored as Drafts | null) ?? empty
  const update = useCallback(
    (change: (drafts: Drafts) => Drafts) => {
      let kept = true
      set((previous) => {
        const before = (previous as Drafts | null) ?? empty
        const next = change(before)
        if (bytes(next) > limits.drafts && bytes(next) > bytes(before)) {
          kept = false
          return previous
        }
        return !next.comments.length && !next.note && next.to === undefined ? null : next
      })
      return kept
    },
    [set],
  )
  return [drafts, update] as const
}

/** What a comment is on, as a short mono label: `node surface`, `edge a → b: label`, or the diagram. */
export const where = (comment: Pick<ArchitectureComment, 'kind' | 'part' | 'label'>) =>
  comment.kind === 'diagram'
    ? 'diagram'
    : // An edge's ID (`L_a_b_0`) means little to a reader; its label is its route.
      `${comment.kind} ${comment.kind === 'edge' ? comment.label : comment.part}`
