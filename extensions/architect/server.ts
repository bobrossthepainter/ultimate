import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  configure,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  defineTool,
  ConversationBusy,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  JsonObject,
  Tx,
} from '@earendil-works/pi-durable'
import { arr, int, map, obj, opt, str } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import { implementAction } from '../../lib/actions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Exec } from '../exec/api.ts'
import { parseError } from './parse.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import {
  ArchitectureDoc,
  ArchitectureIndexDoc,
  ChatAction,
  ChatDoc,
  DraftsDoc,
  DrawAction,
  EditAction,
  SendAction,
} from './refs.ts'
import type {
  Architecture,
  ArchitectureChat,
  ArchitectureCode,
  PartCode,
  ArchitectureComment,
  ArchitectureDrafts,
  DraftEdit,
  Drafts,
  ArchitectureComments,
  ArchitectureDiagram,
  ArchitectureIndex,
  ArchitectureVersion,
} from './refs.ts'

/** A branch's versions, on the branch. */
export const Versions = defineDoc<Architecture>({
  kind: ArchitectureDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ versions: [] }),
})
/** The branches with versions, on the root: what the surface's picker lists. */
export const Index = defineDoc<ArchitectureIndex>({
  kind: ArchitectureIndexDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ branches: {} }),
})
/** On an architect conversation: the branch it draws; `chat` on an architecture chat: the version it was opened at. */
const Of = defineDoc<{ branch?: number; chat?: number }>({
  kind: 'architect.of',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
/** A branch's pending feedback by version, on the branch: the surface and its architecture chat both edit it. */
export const DraftsStore = defineDoc<ArchitectureDrafts>({
  kind: DraftsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ versions: {} }),
})
/** A branch's architecture chat, on the branch. */
export const Chat = defineDoc<ArchitectureChat>({
  kind: ChatDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
/** What one `architecture_publish` call published, on its tool task. */
const Receipt = defineDoc<{ text?: string }>({
  kind: 'architect.receipt',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({}),
})
export const docs = [Versions, Index, DraftsStore, Chat]

/** Feedback the user sent on a version: the input its recipient reads as `commentsText`; card.tsx renders it. */
export const CommentsEntry = defineEntry<ArchitectureComments>('architect.comments')

/** Owns a branch's architect conversation, so the sidebar shows it under the branch; done at once, as subagents' anchor. */
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'architect.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        ctx,
      ),
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})

export const limits = {
  diagrams: 6,
  mermaid: 20_000,
  notes: 8,
  parts: 80,
  comments: 50,
  text: 4000,
} as const

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const slug = /^[a-z0-9][a-z0-9-]{0,40}$/

/** `input` as a diagram's `code` map, every key a part named in `mermaid`, or throws naming what is wrong. */
function checkCode(input: unknown, mermaid: string, at: string): Record<string, PartCode> {
  if (input === undefined) return {}
  if (!record(input) || Object.keys(input).length > limits.parts)
    throw new Error(`${at} must map at most ${limits.parts} part IDs to their code`)
  const code: Record<string, PartCode> = {}
  for (const [part, value] of Object.entries(input)) {
    const where = `${at}.${part}`
    // Edges count too, by the explicit ID the source gives them (`a e1@--> b`): the click on one reports it.
    if (!mermaid.includes(part))
      throw new Error(
        `${where}: no part ${part} in the Mermaid source (give an edge an ID: a e1@--> b)`,
      )
    if (!record(value)) throw new Error(`${where} must be an object`)
    const { source, status = 'implemented', evidence = 'static' } = value
    if (status !== 'implemented' && status !== 'proposed')
      throw new Error(`${where}.status must be implemented or proposed`)
    if (evidence !== 'static' && evidence !== 'runtime')
      throw new Error(`${where}.evidence must be static or runtime`)
    if (status === 'implemented' && source === undefined)
      throw new Error(`${where}: an implemented part needs its source`)
    let checked: PartCode['source']
    if (source !== undefined) {
      if (!record(source)) throw new Error(`${where}.source must be { path, symbol?, line? }`)
      const { path, symbol, line } = source
      if (
        typeof path !== 'string' ||
        !path ||
        path.length > 300 ||
        path.startsWith('/') ||
        path.split('/').includes('..')
      )
        throw new Error(`${where}.source.path must be a path relative to the repository root`)
      if (symbol !== undefined && (typeof symbol !== 'string' || !symbol || symbol.length > 200))
        throw new Error(`${where}.source.symbol must be a short name`)
      if (
        line !== undefined &&
        (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)
      )
        throw new Error(`${where}.source.line must be a line number`)
      checked = {
        path,
        ...(symbol === undefined ? {} : { symbol }),
        ...(line === undefined ? {} : { line }),
      }
    }
    code[part] = { ...(checked ? { source: checked } : {}), status, evidence }
  }
  return code
}

/** `input` as a version's diagrams, or throws naming what is wrong. */
export function checkDiagrams(input: unknown): ArchitectureDiagram[] {
  if (!Array.isArray(input)) throw new Error('diagrams must be a list')
  if (input.length > limits.diagrams) throw new Error(`At most ${limits.diagrams} diagrams`)
  const ids = new Set<string>()
  return input.map((diagram, index) => {
    const at = `diagrams[${index}]`
    if (!record(diagram)) throw new Error(`${at} must be an object`)
    const {
      id,
      title,
      mermaid,
      notes = [],
      parts = {},
      level = 'overview',
      useCase,
      code,
    } = diagram
    if (typeof id !== 'string' || !slug.test(id))
      throw new Error(`${at}.id must be a lowercase slug such as components`)
    if (ids.has(id)) throw new Error(`${at}.id ${id} is used twice`)
    ids.add(id)
    if (typeof title !== 'string' || !title.trim()) throw new Error(`${at}.title must not be empty`)
    if (typeof mermaid !== 'string' || !mermaid.trim())
      throw new Error(`${at}.mermaid must be Mermaid source`)
    if (mermaid.length > limits.mermaid)
      throw new Error(`${at}.mermaid is longer than ${limits.mermaid} characters`)
    if (
      !Array.isArray(notes) ||
      notes.length > limits.notes ||
      notes.some((n) => typeof n !== 'string')
    )
      throw new Error(`${at}.notes must be at most ${limits.notes} short lines`)
    if (!record(parts) || Object.keys(parts).length > limits.parts)
      throw new Error(`${at}.parts must map at most ${limits.parts} part IDs to text`)
    for (const [part, text] of Object.entries(parts))
      if (typeof text !== 'string') throw new Error(`${at}.parts.${part} must be text`)
    if (level !== 'overview' && level !== 'implementation')
      throw new Error(`${at}.level must be overview or implementation`)
    if (useCase !== undefined && (typeof useCase !== 'string' || useCase.length > 200))
      throw new Error(`${at}.useCase must be a short line`)
    if (level === 'implementation' && !useCase?.trim())
      throw new Error(`${at}: an implementation view needs its useCase`)
    return {
      id,
      title: title.trim(),
      mermaid,
      notes: (notes as string[]).map((note) => note.trim()).filter(Boolean),
      parts: parts as Record<string, string>,
      level,
      ...(useCase?.trim() ? { useCase: useCase.trim() } : {}),
      code: checkCode(code, mermaid, `${at}.code`),
    }
  })
}

const checkText = (text: unknown, at: string) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${at} must not be empty`)
  if (text.length > limits.text) throw new Error(`${at} is longer than ${limits.text} characters`)
  return text
}

/** `comment` as a comment on a part of `version`, or throws naming what is wrong. */
export function checkComment(comment: unknown, version: ArchitectureVersion): ArchitectureComment {
  if (!record(comment)) throw new Error('comment must be an object')
  const { diagram, kind, part, label, text } = comment
  const shown = version.diagrams.find((item) => item.id === diagram)
  if (!shown) throw new Error(`v${version.version} has no diagram ${String(diagram)}`)
  if (kind !== 'node' && kind !== 'edge' && kind !== 'participant' && kind !== 'diagram')
    throw new Error('kind must be node, edge, participant or diagram')
  if (kind !== 'diagram' && (typeof part !== 'string' || !part))
    throw new Error('part must name the part by its ID')
  if (kind !== 'diagram' && kind !== 'edge' && !shown.mermaid.includes(part as string))
    throw new Error(`${shown.id} has no part ${String(part)}`)
  if (label !== undefined && typeof label !== 'string') throw new Error('label must be text')
  return {
    diagram: shown.id,
    kind,
    ...(kind === 'diagram' ? {} : { part: part as string }),
    label: (
      label ||
      (kind === 'diagram' ? shown.title : (shown.parts[part as string] ?? (part as string)))
    ).slice(0, 200),
    text: checkText(text, 'text'),
  }
}

const emptyDrafts = (): Drafts => ({ comments: [], note: '' })

/**
 * Apply `edit` to the pending feedback on `version` of `branch` inside `tx`; `by` marks a comment an architecture
 * chat suggested. Returns the new draft's id for `add`.
 */
async function editDrafts(
  tx: Tx,
  branch: ConversationId,
  version: number,
  edit: DraftEdit,
  options: { by?: number; id?: string } = {},
): Promise<{ id?: string }> {
  const shown = (await tx.doc(Versions, branch)).versions.find((item) => item.version === version)
  if (!shown) throw new Error(`#${branch} has no version ${version}`)
  const store = await tx.doc(DraftsStore, branch)
  // Read back after assigning: the doc copies an assigned value, so changes go through the stored draft.
  store.versions[String(version)] ??= emptyDrafts()
  const drafts = store.versions[String(version)]
  const find = (id: string) => {
    const draft = drafts.comments.find((item) => item.id === id)
    if (!draft) throw new Error(`No pending comment ${id} on v${version}`)
    return draft
  }
  let added: string | undefined
  if (edit.op === 'add') {
    if (drafts.comments.length >= limits.comments)
      throw new Error(`At most ${limits.comments} comments at once`)
    added = options.id ?? randomUUID()
    drafts.comments.push({
      ...checkComment(edit.comment, shown),
      id: added,
      ...(options.by === undefined ? {} : { by: options.by }),
    })
  } else if (edit.op === 'update') find(edit.id).text = checkText(edit.text, 'text')
  else if (edit.op === 'delete') {
    find(edit.id)
    drafts.comments = drafts.comments.filter((item) => item.id !== edit.id)
  } else if (edit.op === 'note') {
    if (typeof edit.note !== 'string' || edit.note.length > limits.text)
      throw new Error(`note must be text of at most ${limits.text} characters`)
    drafts.note = edit.note
  } else if (edit.op === 'to') {
    if (
      typeof edit.to !== 'number' ||
      !Number.isSafeInteger(edit.to) ||
      !(await tx.conversation(edit.to as ConversationId))
    )
      throw new Error('to must be an existing conversation id')
    drafts.to = edit.to
  } else if (edit.op === 'clear') Object.assign(drafts, emptyDrafts())
  else throw new Error('op must be add, update, delete, note, to or clear')
  if (!drafts.comments.length && !drafts.note && drafts.to === undefined)
    delete store.versions[String(version)]
  return added === undefined ? {} : { id: added }
}

/** Inline code that holds `value` whatever backticks it contains. */
const code = (value: string) => {
  const run = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1
  const fence = '`'.repeat(run)
  return `${fence}${run > 1 ? ' ' : ''}${value.replace(/\n/g, '\\n')}${run > 1 ? ' ' : ''}${fence}`
}

/** What the recipient's model reads for feedback on `version` (its diagrams give the titles). */
export function commentsText(feedback: ArchitectureComments, version?: ArchitectureVersion) {
  const title = (id: string) => version?.diagrams.find((d) => d.id === id)?.title ?? id
  const count = `${feedback.comments.length} comment${feedback.comments.length === 1 ? '' : 's'}`
  return [
    `Architecture feedback on v${feedback.version} of #${feedback.branch}'s diagrams (${count})`,
    ...(feedback.note ? [feedback.note] : []),
    ...feedback.comments.map((comment) => {
      const where =
        comment.kind === 'diagram'
          ? `**${title(comment.diagram)}**`
          : `**${title(comment.diagram)}** · ${code(comment.part!)} (${comment.kind}${comment.label && comment.label !== comment.part ? `: ${comment.label}` : ''})`
      return `${where}\n${comment.text}`
    }),
  ].join('\n\n')
}

const conversationExists = (host: ExtensionHost, id: number) =>
  host.conversations().some((conversation) => conversation.id === id)

/** The branch conversation `id` stands for: itself, or the branch an architect conversation draws. */
async function branchOf(host: ExtensionHost, id: number, ctx: Context) {
  return (await host.harness().snapshot(Of, id as ConversationId, ctx))?.branch ?? id
}

/** The text of conversation `id`'s latest answer, its coordinator's latest assessment or report. */
async function latestAnswer(host: ExtensionHost, id: number, ctx: Context) {
  const conversation = await host.harness().conversation(id as ConversationId, ctx)
  if (!conversation) return undefined
  const { entries } = await conversation.context(ctx)
  for (const entry of entries.toReversed()) {
    if (entry.kind !== 'pi.assistant') continue
    const text = textOf(entry)
    if (text.trim()) return text
  }
  return undefined
}

const textOf = (entry: EntryRecord) =>
  (entry.model ?? [])
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : [],
    )
    .join('')

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`

type PlanShape = {
  epics: Record<
    string,
    {
      key: string
      title: string
      status: string
      body: string
      tasks: Record<string, { key: string; title: string; status: string }>
    }
  >
}

/** The architect's brief for the next version of `branch`. */
async function brief(host: ExtensionHost, branch: number, ctx: Context) {
  const workspace = await host.need(WorkspacesApi).get(branch as ConversationId, ctx)
  const title = host.conversations().find((c) => c.id === branch)?.title ?? `#${branch}`
  const planToken = host.doc('ultimate.plan')
  const plan = planToken
    ? ((await host.harness().snapshot(planToken, branch as ConversationId, ctx)) as
        | PlanShape
        | undefined)
    : undefined
  const epics = Object.values(plan?.epics ?? {})
  const previous = (
    await host.harness().snapshot(Versions, branch as ConversationId, ctx)
  )?.versions.at(-1)
  const assessment = await latestAnswer(host, branch, ctx)
  const changed =
    workspace?.state === 'ready'
      ? await host
          .need(Exec)
          .git(workspace.path, 'diff', '--stat=120', `${workspace.target}...HEAD`)
          .catch(
            // A worktree mid-setup or with an unknown target: the brief still names the command to read it.
            () => '',
          )
      : undefined
  const where =
    workspace?.state === 'ready'
      ? [
          `Worktree: ${workspace.path}`,
          `Branch: ${workspace.branch}, landing on ${workspace.target}.`,
          `Its change: \`git -C ${workspace.path} diff ${workspace.target}...HEAD\` plus uncommitted work (\`git -C ${workspace.path} status --short\`, \`git -C ${workspace.path} diff HEAD\`).`,
        ]
      : [
          `It has no worktree of its own: read the project checkout at ${host.projectRoot} and what the plan and assessment describe.`,
        ]
  return [
    `Draw version ${(previous?.version ?? 0) + 1} of the architecture of branch #${branch} "${title}".`,
    where.join('\n'),
    epics.length
      ? `## Plan\n\n${clip(
          epics
            .map(
              (epic) =>
                `### ${epic.key} ${epic.status} ${epic.title}\n\n${epic.body}\n\n${Object.values(
                  epic.tasks,
                )
                  .map((task) => `- ${task.key} ${task.status} ${task.title}`)
                  .join('\n')}`,
            )
            .join('\n\n'),
          12_000,
        )}`
      : '## Plan\n\nNone yet.',
    ...(changed === undefined
      ? []
      : [
          changed
            ? `## Changed files (committed)\n\n\`\`\`\n${clip(changed, 6000)}\n\`\`\`\n\nCode changed: publish the implementation views for its important use cases besides the overview.`
            : '## Changed files (committed)\n\nNothing committed yet: unless uncommitted work holds code, publish no implementation view.',
        ]),
    assessment
      ? `## The coordinator's latest answer\n\n${clip(assessment, 8000)}`
      : "## The coordinator's latest answer\n\nNone yet.",
    previous
      ? `## Previous version (v${previous.version}): keep its diagram and part IDs\n\n${JSON.stringify(
          {
            title: previous.title,
            summary: previous.summary,
            diagrams: previous.diagrams,
          },
          null,
          1,
        )}`
      : '## Previous version\n\nNone: this is the first.',
    'Publish with `architecture_publish`, then answer with its one-line summary.',
  ].join('\n\n')
}

/**
 * Start the architect of `branch` on a new version: its conversation (made on first use, under the branch) gets the
 * brief as input. Starts nothing while it still draws. Only the user draws (Draw, ⌘K): no agent has a tool for it.
 */
async function draw(host: ExtensionHost, requested: number, ctx: Context) {
  const branch = await branchOf(host, requested, ctx)
  if (!conversationExists(host, branch))
    throw new Error('conversation must be an existing conversation id')
  const definition = (
    await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
  ).definitions.find((item) => item.name === 'architect')
  if (!definition) throw new Error('Missing the architect agent definition')
  const parent = await (await host.harness().conversation(branch as ConversationId, ctx))!.agent(
    ctx,
  )
  const workspace = await host.need(WorkspacesApi).get(branch as ConversationId, ctx)
  const title = host.conversations().find((c) => c.id === branch)?.title ?? `#${branch}`
  const text = await brief(host, branch, ctx)
  const cwd = workspace?.state === 'ready' ? workspace.path : host.projectRoot
  const architect = await host.harness().commit(async (tx) => {
    const state = await tx.doc(Versions, branch as ConversationId)
    if (
      state.architect !== undefined &&
      (await tx.conversation(state.architect as ConversationId))
    ) {
      // A landed branch's worktree is gone: a later Draw reads the project checkout instead.
      await configure(tx, state.architect as ConversationId, { cwd })
      return state.architect as ConversationId
    }
    const owner = await tx.createTask(Anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: branch as ConversationId,
      background: true,
    })
    const child = await host.need(SubagentsApi).createChild(tx, {
      owner: { kind: 'task', taskId: owner },
      definition,
      parentAgent: parent,
      modelRuntime: host.modelRuntime,
      metadata: host.metadata,
      label: 'architect',
      title: `Architecture · ${title}`,
      excludeTools: ['subagent'],
      excludeExtensions: ['subagents'],
      cwd,
    })
    // Its title stays the branch's; its answers are one-line summaries.
    await host.need(ConversationsApi).setAutomaticSummaries(tx, child.id, false)
    ;(await tx.doc(Of, child.id)).branch = branch
    state.architect = child.id
    return child.id
  }, ctx)
  try {
    await (await host.harness().conversation(architect, ctx))!.submit(
      {
        type: 'input',
        content: text,
        // A Draw while the architect still draws starts nothing; the admission checks it atomically.
        whenBusy: 'reject',
      },
      ctx,
    )
  } catch (error) {
    if (error instanceof ConversationBusy) return { architect: architect as number, started: false }
    throw error
  }
  return { architect: architect as number, started: true }
}

/** The branch of a `{ branch, version }` argument, or throws. */
function target(host: ExtensionHost, args: unknown) {
  const branch = record(args) ? args.branch : undefined
  const version = record(args) ? args.version : undefined
  if (
    typeof branch !== 'number' ||
    !Number.isSafeInteger(branch) ||
    !conversationExists(host, branch)
  )
    throw new Error('branch must be an existing conversation id')
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
    throw new Error('version must be a version number')
  return { branch: branch as ConversationId, version }
}

const chatInstructions = (branch: number) =>
  [
    `## Architecture chat`,
    `You are now the architecture chat of branch #${branch}: a copy of its architect, opened from the Architecture tab beside the diagrams you drew. The user asks clarifying questions and discusses refactoring ideas with you. Answer briefly, grounded in the code (read-only, as before); sketch an alternative as a small Mermaid block in your answer when it helps.`,
    `Do not publish a new version: the user asks for one with Draw. When the discussion yields feedback for the branch's coordinator, propose it as a pending comment with \`architecture_comment\` (on a part by its ID, or on a whole diagram), worded for the coordinator; the user reviews, edits and sends the list. \`architecture_comment {action: "list"}\` shows what is pending.`,
  ].join('\n\n')

/**
 * The branch's architecture chat: a fork of its architect at its latest finished answer, made again when `fresh` or
 * when a newer version exists than the one it was forked at.
 */
async function chat(host: ExtensionHost, branch: ConversationId, fresh: boolean, ctx: Context) {
  const versions = (await host.harness().snapshot(Versions, branch, ctx)) ?? { versions: [] }
  const latest = versions.versions.at(-1)
  if (!latest || versions.architect === undefined)
    throw new Error(`#${branch} has no architecture version to discuss yet`)
  const architect = versions.architect as ConversationId
  const current = await host.harness().snapshot(Chat, branch, ctx)
  if (
    !fresh &&
    current?.id !== undefined &&
    current.version === latest.version &&
    conversationExists(host, current.id)
  )
    return current.id
  // Its latest finished turn: a fork there inherits the brief, its reading and the published diagrams, never a run
  // still drawing.
  let answer: EntryId | undefined
  let cursor: Cursor | undefined
  do {
    const page = await host.scanSubmissions(
      { conversationId: architect, status: 'done' },
      100,
      cursor,
      ctx,
    )
    for (const input of page.items)
      if (
        input.type === 'input' &&
        input.status === 'done' &&
        (answer === undefined || input.answer > answer)
      )
        answer = input.answer
    cursor = page.next
  } while (cursor)
  if (answer === undefined) throw new Error(`The architect of #${branch} has not answered yet`)
  const live = await host.harness().snapshot(LiveDoc, architect, ctx)
  if (live?.run)
    throw new Error('The architect is still drawing: open the chat once it has published')
  const parent = await (await host.harness().conversation(architect, ctx))!.agent(ctx)
  // The architect's definition leaves `architecture_comment` out; the branch's agent still has every tool.
  const branchAgent = await (await host.harness().conversation(branch, ctx))!.agent(ctx)
  const comment = [...branchAgent.tools, ...branchAgent.deferred].find(
    (tool) => tool.name === 'architecture_comment',
  )
  if (!comment) throw new Error('architecture_comment is not available: is architect enabled?')
  const title = host.conversations().find((c) => c.id === branch)?.title ?? `#${branch}`
  return host.harness().commit(async (tx) => {
    const owner = await tx.createTask(Anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: branch,
      background: true,
    })
    const fork = await tx.forkConversation(architect, answer, {
      ownership: { kind: 'task', taskId: owner },
    })
    await configure(tx, fork.id, {
      instructions: `${parent.instructions ?? ''}\n\n${chatInstructions(branch)}`,
      tools: [...parent.tools.filter((tool) => tool.name !== 'architecture_publish'), comment],
      // A deferred tool is offered only once named here.
      modelTools: { add: [comment] },
    })
    Object.assign(await tx.doc(host.metadata, fork.id), {
      label: 'architecture chat',
      title: `Architecture chat · ${title}`,
    })
    await host.need(ConversationsApi).setAutomaticSummaries(tx, fork.id, false)
    Object.assign(await tx.doc(Of, fork.id), { branch, chat: latest.version })
    Object.assign(await tx.doc(Chat, branch), { id: fork.id, version: latest.version })
    return fork.id
  }, ctx)
}

export const userActions = ['send', 'edit', 'chat']

export const actions = {
  draw: implementAction(DrawAction, async (args, { host }) => {
    const id = record(args) ? args.conversation : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !conversationExists(host, id))
      throw new Error('conversation must be an existing conversation id')
    const { architect, started } = await draw(host, id, context)
    return { architect, started }
  }),
  edit: implementAction(EditAction, async (args, { host }) => {
    const { branch, version } = target(host, args)
    const edit = record(args) && record(args.edit) ? (args.edit as DraftEdit) : undefined
    if (!edit) throw new Error('Expected { branch, version, edit }')
    return host.harness().commit((tx) => editDrafts(tx, branch, version, edit), context)
  }),
  chat: implementAction(ChatAction, async (args, { host }) => {
    const id = record(args) ? args.branch : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !conversationExists(host, id))
      throw new Error('branch must be an existing conversation id')
    const branch = (await branchOf(host, id, context)) as ConversationId
    return { chat: await chat(host, branch, record(args) && args.fresh === true, context) }
  }),
  send: implementAction(SendAction, async (args, { host, device }) => {
    const { branch, version: number } = target(host, args)
    const version = (await host.harness().snapshot(Versions, branch, context))?.versions.find(
      (item) => item.version === number,
    )
    if (!version) throw new Error(`#${branch} has no version ${number}`)
    const recipient = (await host.harness().snapshot(DraftsStore, branch, context))?.versions[
      String(number)
    ]?.to
    const id = recipient ?? branch
    if (!conversationExists(host, id)) throw new Error(`No conversation #${id}`)
    const conversation = (await host.harness().conversation(id as ConversationId, context))!
    // One commit reads the pending feedback, admits it as the recipient's input and clears it: an edit made meanwhile
    // is either in what was sent or still pending, and a crash leaves both or neither.
    await host.harness().commit(async (tx) => {
      const store = await tx.doc(DraftsStore, branch)
      const pending = store.versions[String(number)]
      if (!pending?.comments.length) throw new Error(`No comments pending on v${number}`)
      if ((pending.to ?? branch) !== id) throw new Error('The recipient changed: send again')
      const feedback: ArchitectureComments = {
        branch,
        version: number,
        comments: pending.comments.map(({ id: _id, by: _by, ...comment }) => comment),
        ...(pending.note.trim() ? { note: pending.note.trim() } : {}),
      }
      const content = commentsText(feedback, version)
      const submission = await conversation.submit(tx, {
        type: 'input',
        content,
        entry: { kind: CommentsEntry.kind, data: feedback },
        // The user's input: it steers a busy recipient as a typed message would.
        whenBusy: 'steer',
      })
      delete store.versions[String(number)]
      await host.emit(tx, UserInputEvent, {
        conversation: id,
        kind: 'review',
        submission,
        length: content.length,
        ...device,
      })
    }, context)
    return { conversation: id }
  }),
}

/**
 * Where `diagrams`' sources were read for `branch`: its worktree's change as a Review spec, the files it changes and
 * the branch the rest is on. Throws naming a source path the checkout does not have, so every link is grounded.
 */
async function grounding(
  host: ExtensionHost,
  branch: number | undefined,
  diagrams: ArchitectureDiagram[],
  ctx: Context,
): Promise<ArchitectureCode | undefined> {
  const paths = new Set(
    diagrams.flatMap((diagram) =>
      Object.values(diagram.code ?? {}).flatMap((part) => (part.source ? [part.source.path] : [])),
    ),
  )
  if (!paths.size || branch === undefined) return undefined
  const workspace = await host.need(WorkspacesApi).get(branch as ConversationId, ctx)
  const ready = workspace?.state === 'ready'
  const cwd = ready ? workspace.path : host.projectRoot
  const git = host.need(Exec).git
  const lines = (text: string) => text.split('\n').filter(Boolean)
  // The files committed at HEAD: what Review and GitHub open, so an uncommitted or deleted file never becomes a link.
  const known = new Set(lines(await git(cwd, 'ls-tree', '-r', '--name-only', 'HEAD')))
  const missing = [...paths].filter((path) => !known.has(path))
  if (missing.length)
    throw new Error(
      `No such file committed on the branch: ${missing.join(', ')}. Give source paths relative to the repository root, of committed files; draw uncommitted code as proposed.`,
    )
  if (!ready)
    return {
      changed: [],
      ref: await git(cwd, 'symbolic-ref', '--short', 'HEAD').catch(
        // A detached checkout has no branch: links point at its commit.
        () => git(cwd, 'rev-parse', 'HEAD'),
      ),
    }
  return {
    spec: `branch:${workspace.branch}`,
    changed: lines(await git(cwd, 'diff', '--name-only', `${workspace.target}...HEAD`)),
    ref: workspace.target,
  }
}

const result = (text: string, structured?: JsonObject) => ({
  output: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
})

export default (host: ExtensionHost) =>
  defineExtension({
    name: 'architect',
    tasks: [Anchor],
    tools: [
      defineTool({
        name: 'architecture_publish',
        deferred: true,
        // Its receipt records the published version in the commit that appends it.
        replay: 'safe',
        description:
          "Publish this architect's version of its branch's architecture: a title, a one-line summary and up to 6 Mermaid diagrams, each with a stable lowercase id (kept across versions), short notes and a map of part IDs (node IDs, or a sequence diagram's participants) to what each part is. Mark changed parts with :::added, :::changed or :::removed. An implementation view (level implementation, its useCase) maps its parts in `code` to their source (path relative to the repository root, symbol, line), status (implemented or proposed) and evidence (static or runtime); every implemented part needs a source that exists. With nothing architectural changed, publish no diagrams and say so in the summary.",
        parameters: obj({
          title: str({ minLength: 1, maxLength: 120 }),
          summary: str({ minLength: 1, maxLength: 400 }),
          diagrams: arr(
            obj({
              id: str({
                description: 'Stable lowercase slug, the same for the same view across versions.',
              }),
              title: str(),
              mermaid: str({ description: 'Mermaid source with stable node IDs.' }),
              notes: opt(arr(str())),
              parts: opt(map(str(), { description: 'Part ID → what it is, in a few words.' })),
              level: opt(
                strEnum(['overview', 'implementation'] as const, {
                  description:
                    'overview (default): components, flows, stored shapes; implementation: the call path of one use case through the actual code.',
                }),
              ),
              useCase: opt(
                str({
                  description:
                    'The use case an implementation view follows, in a few words ("Send feedback to the coordinator").',
                }),
              ),
              code: opt(
                map(
                  obj({
                    source: opt(
                      obj({
                        path: str({ description: 'Relative to the repository root.' }),
                        symbol: opt(str({ description: 'Class, interface, function or method.' })),
                        line: opt(int({ minimum: 1 })),
                      }),
                    ),
                    status: opt(strEnum(['implemented', 'proposed'] as const)),
                    evidence: opt(strEnum(['static', 'runtime'] as const)),
                  }),
                  {
                    description:
                      'Part ID (node, participant, or an edge by its explicit ID) → its source, status (default implemented) and evidence (default static).',
                  },
                ),
              ),
            }),
            { maxItems: limits.diagrams },
          ),
        }),
        execute: async (args, api, ctx) => {
          // A replay after a restart returns what was published before checking anything against the checkout again.
          const published = await api.commit(
            async (tx) => (await tx.doc(Receipt, api.taskId)).text,
            ctx,
          )
          if (published !== undefined) return result(published)
          const diagrams = checkDiagrams(args.diagrams)
          for (const diagram of diagrams) {
            const error = await parseError(diagram.mermaid)
            if (error) throw new Error(`Mermaid cannot draw ${diagram.id}: ${error}`)
          }
          const sources = await grounding(
            host,
            (await host.harness().snapshot(Of, api.conversationId, ctx))?.branch,
            diagrams,
            ctx,
          )
          const text = await api.commit(async (tx) => {
            // The receipt commits with the version: a replay after a restart finds it and appends nothing.
            const receipt = await tx.doc(Receipt, api.taskId)
            if (receipt.text !== undefined) return receipt.text
            const { branch, chat: chatting } = await tx.doc(Of, api.conversationId)
            if (branch === undefined || chatting !== undefined)
              throw new Error('Only an architect conversation started by Draw can publish')
            const state = await tx.doc(Versions, branch as ConversationId)
            const version: ArchitectureVersion = {
              version: (state.versions.at(-1)?.version ?? 0) + 1,
              at: new Date(api.now()).toISOString(),
              architect: api.conversationId,
              title: args.title.trim(),
              summary: args.summary.trim(),
              diagrams,
              ...(sources ? { code: sources } : {}),
            }
            state.versions.push(version)
            ;(await tx.doc(Index, ROOT_CONVERSATION_ID)).branches[String(branch)] = {
              version: version.version,
              at: version.at,
            }
            receipt.text = `Published version ${version.version} of #${branch} with ${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'}.`
            return receipt.text
          }, ctx)
          return result(text)
        },
      }),
      defineTool({
        name: 'architecture_comment',
        deferred: true,
        // The receipt commits with the change: a replay after a restart applies nothing twice.
        replay: 'safe',
        description:
          "Propose feedback for the branch's coordinator as pending comments the user reviews in the Architecture tab, on the version you were opened at. add {diagram, kind: node|edge|participant|diagram, part?, text}: a comment on a part by its ID in the Mermaid source (an edge by the ID Mermaid draws it with: its explicit ID when the source gives one, else L_<source>_<target>_<n> in a flowchart, n counting from 0 per pair, e.g. L_surface_doc_0), or on the whole diagram; update {id, text} and delete {id} change only comments you added; list shows every pending comment with its id. The user sends the list; you never send it.",
        parameters: obj({
          action: strEnum(['add', 'update', 'delete', 'list'] as const),
          diagram: opt(str()),
          kind: opt(strEnum(['node', 'edge', 'participant', 'diagram'] as const)),
          part: opt(str()),
          text: opt(str()),
          id: opt(str()),
        }),
        execute: async (args, api, ctx) => {
          const text = await api.commit(async (tx) => {
            const receipt = await tx.doc(Receipt, api.taskId)
            if (receipt.text !== undefined) return receipt.text
            // The version this chat was opened at, kept on the chat: a newer chat on the branch does not move it.
            const { branch, chat: version } = await tx.doc(Of, api.conversationId)
            if (branch === undefined || version === undefined)
              throw new Error(
                'Only an architecture chat opened from the Architecture tab can comment',
              )
            const key = branch as ConversationId
            const pending = () =>
              tx
                .doc(DraftsStore, key)
                .then((store) => store.versions[String(version)]?.comments ?? [])
            const own = async (id: string | undefined) => {
              const draft = (await pending()).find((item) => item.id === id)
              if (!draft) throw new Error(`No pending comment ${String(id)} on v${version}`)
              if (draft.by !== api.conversationId)
                throw new Error(`Comment ${draft.id} is the user's: suggest a change instead`)
              return draft.id
            }
            if (args.action === 'list') {
              const list = await pending()
              return list.length
                ? list
                    .map(
                      (draft) =>
                        `${draft.id} · ${draft.by === undefined ? 'user' : 'you'} · ${draft.diagram}${draft.part ? ` ${draft.kind} ${draft.part}` : ''}: ${draft.text}`,
                    )
                    .join('\n')
                : `No comments pending on v${version}.`
            }
            let done: string
            if (args.action === 'add') {
              const kind = args.kind ?? (args.part ? 'node' : 'diagram')
              const { id } = await editDrafts(
                tx,
                key,
                version,
                {
                  op: 'add',
                  comment: {
                    diagram: args.diagram ?? '',
                    kind,
                    ...(args.part ? { part: args.part } : {}),
                    label: '',
                    text: args.text ?? '',
                  },
                },
                { by: api.conversationId, id: `c${api.taskId}` },
              )
              done = `Added pending comment ${id} on v${version}; the user reviews and sends it.`
            } else if (args.action === 'update') {
              const id = await own(args.id)
              await editDrafts(tx, key, version, { op: 'update', id, text: args.text ?? '' })
              done = `Updated pending comment ${id}.`
            } else {
              const id = await own(args.id)
              await editDrafts(tx, key, version, { op: 'delete', id })
              done = `Deleted pending comment ${id}.`
            }
            receipt.text = done
            return done
          }, ctx)
          return result(text)
        },
      }),
    ],
  })
