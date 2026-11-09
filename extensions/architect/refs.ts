/** Architecture diagrams in the browser: each branch's versions, the index of branches that have any, and the actions that draw them and send feedback on them. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/**
 * One diagram of a version. `id` names it across versions (`components`, `publish-flow`), so a comparison pairs it with
 * its earlier self. `mermaid` is the source as the architect wrote it, with stable node IDs and `:::added`,
 * `:::changed` or `:::removed` on the parts that changed; `parts` maps each part ID (a node, or a sequence diagram's
 * participant) to what it is, in a few words.
 *
 * `level` says what it draws: `overview` (components, flows, stored shapes) or `implementation`, the call path of one
 * `useCase` through the code's actual classes, interfaces and functions. `code` maps part IDs (nodes, participants and
 * edges) to where each lives in the source and how sure it is, beside the Mermaid drawing.
 */
export type ArchitectureDiagram = {
  id: string
  title: string
  mermaid: string
  notes: string[]
  parts: Record<string, string>
  /** Both absent on diagrams published before implementation views: an overview without code. */
  level?: 'overview' | 'implementation'
  useCase?: string
  code?: Record<string, PartCode>
}

/**
 * A part's grounding in code. `source` is a path relative to the repository root, with the symbol and line it names;
 * `status` is `implemented` (in the code the architect read) or `proposed` (planned, not in code yet); `evidence` is
 * `static` (read from the source) or `runtime` (seen in an observed trace).
 */
export type PartCode = {
  source?: { path: string; symbol?: string; line?: number }
  status: 'implemented' | 'proposed'
  evidence: 'static' | 'runtime'
}

/**
 * Where a version's sources were read: the Review `spec` of the branch's change (`branch:<name>`) and the paths it
 * changes, so a source link opens a changed file there; `ref` is the branch the rest of the code is on.
 */
export type ArchitectureCode = { spec?: string; changed: string[]; ref: string }

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
  /** Where its source links point; absent on versions published before links existed. */
  code?: ArchitectureCode
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

/**
 * A comment not sent yet. `id` tells drafts on the same part apart; `by` is the architecture chat that suggested it,
 * absent for the user's own.
 */
export type Draft = ArchitectureComment & { id: string; by?: number }
/** A version's pending feedback: its comments, the overall note, and the recipient the user picked, if any. */
export type Drafts = { comments: Draft[]; note: string; to?: number }
/** The pending feedback of a branch, on the branch: by version number. */
export type ArchitectureDrafts = { versions: Record<string, Drafts> }

/** A branch's architecture chat, on the branch: the conversation and the version it was forked at. */
export type ArchitectureChat = { id?: number; version?: number }

/** A branch's versions, on the branch's conversation. */
export const ArchitectureDoc = docRef<Architecture>('architect.versions')
/** A branch's pending feedback, on the branch's conversation. */
export const DraftsDoc = docRef<ArchitectureDrafts>('architect.drafts')
/** A branch's architecture chat, on the branch's conversation. */
export const ChatDoc = docRef<ArchitectureChat>('architect.chat')
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

/** One change to a version's pending feedback. */
export type DraftEdit =
  | { op: 'add'; comment: ArchitectureComment }
  | { op: 'update'; id: string; text: string }
  | { op: 'delete'; id: string }
  | { op: 'note'; note: string }
  | { op: 'to'; to: number }
  | { op: 'clear' }

/**
 * User only: `{ branch, version, edit }` → `{ id? }` (the new draft's id for `add`): change the version's pending
 * feedback in `architect.drafts`. At most 50 comments of at most 4,000 characters; throws on an unknown version or id.
 */
export const EditAction = actionRef<
  { branch: number; version: number; edit: DraftEdit },
  { id?: string }
>('architect', 'edit')

/**
 * User only: `{ branch, version }` → `{ conversation }`: send the version's pending feedback as one
 * `architect.comments` input into its recipient (`to`, else the branch's coordinator), which wakes or steers it like a
 * typed message, and clear the comments sent. Throws on an unknown version or with no comments pending.
 */
export const SendAction = actionRef<{ branch: number; version: number }, { conversation: number }>(
  'architect',
  'send',
)

/**
 * User only: `{ branch, fresh? }` → `{ chat }`: the branch's architecture chat, a copy of its architect at its latest
 * answer, made on first use (or again with `fresh`, or once a newer version exists). Throws while the branch has no
 * version or its architect still draws.
 */
export const ChatAction = actionRef<{ branch: number; fresh?: boolean }, { chat: number }>(
  'architect',
  'chat',
)
