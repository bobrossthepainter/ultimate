/** Architecture diagrams in the browser: each branch's versions, the index of branches that have any, and the actions that draw them and send feedback on them. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/**
 * One diagram of a version. `id` names it across versions (`components`, `publish-flow`), so a comparison pairs it with
 * its earlier self. `mermaid` is the source as the architect wrote it, with stable node IDs and `:::added`,
 * `:::changed` or `:::removed` on the parts that changed; `parts` maps each part ID (a node, or a sequence diagram's
 * participant) to what it is, in a few words.
 */
export type ArchitectureDiagram = {
  id: string
  title: string
  mermaid: string
  notes: string[]
  parts: Record<string, string>
}

/** One run of the architect: a title, a one-line summary and its diagrams; none when nothing architectural changed. */
export type ArchitectureVersion = {
  /** 1, 2, 3… in the order they were published. */
  version: number
  /** ISO time of publication. */
  at: string
  /** The architect conversation that drew it. */
  architect: number
  title: string
  summary: string
  diagrams: ArchitectureDiagram[]
}

/** A branch's architecture, on the branch: its versions, oldest first, and its architect conversation once it has one. */
export type Architecture = { versions: ArchitectureVersion[]; architect?: number }

/** The branches with at least one version, on the root: by conversation id, its latest version number and time. */
export type ArchitectureIndex = { branches: Record<string, { version: number; at: string }> }

/**
 * One comment on a diagram: on a part (`node`, `edge` or `participant`, by its ID in the Mermaid source) or on the
 * whole `diagram`. `label` is what the user saw when commenting: a part's text, or the diagram's title.
 */
export type ArchitectureComment = {
  diagram: string
  kind: 'node' | 'edge' | 'participant' | 'diagram'
  part?: string
  label: string
  text: string
}

/** What feedback on a version carries into its recipient's transcript, as the data of its `architect.comments` entry. */
export type ArchitectureComments = {
  branch: number
  version: number
  comments: ArchitectureComment[]
  note?: string
}

/** A branch's versions, on the branch's conversation. */
export const ArchitectureDoc = docRef<Architecture>('architect.versions')
/** The branches that have versions, on the root conversation. */
export const ArchitectureIndexDoc = docRef<ArchitectureIndex>('architect.index')

/**
 * `{ conversation }` → `{ architect, started }`: start the branch's architect on a new version of its diagrams, in
 * the architect conversation it already has or a new one under it. `started` is false while that architect is still
 * drawing: the call then starts nothing. Throws on an unknown conversation or without an `architect` agent definition.
 */
export const DrawAction = actionRef<
  { conversation: number },
  { architect: number; started: boolean }
>('architect', 'draw')

/**
 * User only: `{ conversation, branch, version, comments, note? }` → `{ conversation }`: one `architect.comments`
 * input into `conversation` (the branch's coordinator unless the user picked another), which wakes or steers it like a
 * typed message. At most 50 comments of at most 4,000 characters each; throws on an unknown conversation or version.
 */
export const SendAction = actionRef<
  { conversation: number } & ArchitectureComments,
  { conversation: number }
>('architect', 'send')
