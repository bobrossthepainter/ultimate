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
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import { arr, map, obj, opt, str } from '@earendil-works/pi-schema'
import { implementAction } from '../../lib/actions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { ArchitectureDoc, ArchitectureIndexDoc, DrawAction, SendAction } from './refs.ts'
import type {
  Architecture,
  ArchitectureComment,
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
/** On an architect conversation: the branch it draws. */
const Of = defineDoc<{ branch?: number }>({
  kind: 'architect.of',
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
export const docs = [Versions, Index]

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

/** `input` as a version's diagrams, or throws naming what is wrong. */
export function checkDiagrams(input: unknown): ArchitectureDiagram[] {
  if (!Array.isArray(input)) throw new Error('diagrams must be a list')
  if (input.length > limits.diagrams) throw new Error(`At most ${limits.diagrams} diagrams`)
  const ids = new Set<string>()
  return input.map((diagram, index) => {
    const at = `diagrams[${index}]`
    if (!record(diagram)) throw new Error(`${at} must be an object`)
    const { id, title, mermaid, notes = [], parts = {} } = diagram
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
    return {
      id,
      title: title.trim(),
      mermaid,
      notes: (notes as string[]).map((note) => note.trim()).filter(Boolean),
      parts: parts as Record<string, string>,
    }
  })
}

/** `input` as feedback on a version, or throws naming what is wrong. */
export function checkComments(input: unknown): ArchitectureComments {
  if (!record(input)) throw new Error('Expected { branch, version, comments, note? }')
  const { branch, version, comments, note } = input
  if (typeof branch !== 'number' || !Number.isSafeInteger(branch) || branch < 1)
    throw new Error('branch must be a conversation id')
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
    throw new Error('version must be a version number')
  if (!Array.isArray(comments) || comments.length === 0)
    throw new Error('comments must be a non-empty list')
  if (comments.length > limits.comments)
    throw new Error(`At most ${limits.comments} comments at once`)
  if (note !== undefined && (typeof note !== 'string' || note.length > limits.text))
    throw new Error(`note must be text of at most ${limits.text} characters`)
  const checked = comments.map((comment, index): ArchitectureComment => {
    const at = `comments[${index}]`
    if (!record(comment)) throw new Error(`${at} must be an object`)
    const { diagram, kind, part, label, text } = comment
    if (typeof diagram !== 'string' || !diagram) throw new Error(`${at}.diagram must be an id`)
    if (kind !== 'node' && kind !== 'edge' && kind !== 'participant' && kind !== 'diagram')
      throw new Error(`${at}.kind must be node, edge, participant or diagram`)
    if (kind !== 'diagram' && (typeof part !== 'string' || !part))
      throw new Error(`${at}.part must name the part`)
    if (typeof label !== 'string') throw new Error(`${at}.label must be text`)
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${at}.text must not be empty`)
    if (text.length > limits.text)
      throw new Error(`${at}.text is longer than ${limits.text} characters`)
    return {
      diagram,
      kind,
      ...(kind === 'diagram' ? {} : { part: part as string }),
      label: label.slice(0, 200),
      text,
    }
  })
  return {
    branch,
    version,
    comments: checked,
    ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
  }
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
async function brief(
  host: ExtensionHost,
  branch: number,
  reason: string | undefined,
  ctx: Context,
) {
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
    ...(reason ? [`Why now: ${reason}`] : []),
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
 * brief as input. `ifIdle` starts nothing while it still draws.
 */
async function draw(
  host: ExtensionHost,
  requested: number,
  options: { reason?: string; requestId?: string; ifIdle?: boolean },
  ctx: Context,
) {
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
  const text = await brief(host, branch, options.reason, ctx)
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
  let submission
  try {
    submission = await (await host.harness().conversation(architect, ctx))!.submit(
      {
        type: 'input',
        content: text,
        // A Draw while the architect still draws starts nothing; the admission checks it atomically.
        whenBusy: options.ifIdle ? 'reject' : 'followUp',
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
      ctx,
    )
  } catch (error) {
    if (error instanceof ConversationBusy) return { architect: architect as number, started: false }
    throw error
  }
  return { architect: architect as number, started: true, submission, branch }
}

export const userActions = ['send']

export const actions = {
  draw: implementAction(DrawAction, async (args, { host }) => {
    const id = record(args) ? args.conversation : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !conversationExists(host, id))
      throw new Error('conversation must be an existing conversation id')
    const { architect, started } = await draw(
      host,
      id,
      { reason: 'The user asked for a new version.', ifIdle: true },
      context,
    )
    return { architect, started }
  }),
  send: implementAction(SendAction, async (args, { host, device }) => {
    const id = record(args) ? args.conversation : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !conversationExists(host, id))
      throw new Error('conversation must be an existing conversation id')
    const feedback = checkComments(args)
    const version = (
      await host.harness().snapshot(Versions, feedback.branch as ConversationId, context)
    )?.versions.find((item) => item.version === feedback.version)
    if (!version) throw new Error(`#${feedback.branch} has no version ${feedback.version}`)
    const conversation = (await host.harness().conversation(id as ConversationId, context))!
    const content = commentsText(feedback, version)
    const submission = await conversation.submit(
      {
        type: 'input',
        content,
        entry: { kind: CommentsEntry.kind, data: feedback },
        // The user's input: it steers a busy recipient as a typed message would.
        whenBusy: 'steer',
      },
      context,
    )
    // In a commit of its own right after the input's, as review's send: a crash in between loses only the event.
    const admitted = await submission.status(context)
    await host.harness().commit(
      (tx) =>
        host.emit(tx, UserInputEvent, {
          conversation: id,
          kind: 'review',
          ...(admitted.entry === undefined
            ? { submission: submission.id }
            : { entry: admitted.entry }),
          length: content.length,
          ...device,
        }),
      context,
    )
    return { conversation: id }
  }),
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
          "Publish this architect's version of its branch's architecture: a title, a one-line summary and up to 6 Mermaid diagrams, each with a stable lowercase id (kept across versions), short notes and a map of part IDs (node IDs, or a sequence diagram's participants) to what each part is. Mark changed parts with :::added, :::changed or :::removed. With nothing architectural changed, publish no diagrams and say so in the summary.",
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
            }),
            { maxItems: limits.diagrams },
          ),
        }),
        execute: async (args, api, ctx) => {
          const diagrams = checkDiagrams(args.diagrams)
          const text = await api.commit(async (tx) => {
            // The receipt commits with the version: a replay after a restart finds it and appends nothing.
            const receipt = await tx.doc(Receipt, api.taskId)
            if (receipt.text !== undefined) return receipt.text
            const branch = (await tx.doc(Of, api.conversationId)).branch
            if (branch === undefined)
              throw new Error('Only an architect conversation started by Draw can publish')
            const state = await tx.doc(Versions, branch as ConversationId)
            const version: ArchitectureVersion = {
              version: (state.versions.at(-1)?.version ?? 0) + 1,
              at: new Date(api.now()).toISOString(),
              architect: api.conversationId,
              title: args.title.trim(),
              summary: args.summary.trim(),
              diagrams,
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
        name: 'draw_architecture',
        deferred: true,
        // Rerun after a restart: the same request id finds the brief already given and waits for it again.
        replay: 'safe',
        description:
          "Have the architect draw a new version of this branch's architecture diagrams for the user (the Architecture tab) and wait for it: once your plan is set, and again before workspace submit. Returns the architect's summary.",
        parameters: obj({
          reason: opt(
            str({ description: 'Why now, in a few words: "plan set", "before submit".' }),
          ),
        }),
        execute: async (args, api, ctx) => {
          const started = await draw(
            host,
            api.conversationId,
            {
              ...(args.reason ? { reason: args.reason } : {}),
              requestId: `architect:${api.taskId}:${api.callId}`,
            },
            ctx,
          )
          if (!('submission' in started) || !started.submission)
            throw new Error('The architect did not start')
          const settled = await started.submission.wait(ctx)
          const answer =
            settled.answer === undefined
              ? undefined
              : await host.harness().commit((tx) => tx.entry(settled.answer), ctx)
          const latest = (
            await host.harness().snapshot(Versions, started.branch as ConversationId, ctx)
          )?.versions.at(-1)
          const summary = answer ? textOf(answer).trim() : ''
          return result(
            settled.status === 'done'
              ? `Architect #${started.architect}: ${summary || '(no answer)'}${latest ? `\nLatest version: v${latest.version} "${latest.title}" with ${latest.diagrams.length} diagram${latest.diagrams.length === 1 ? '' : 's'}.` : '\nNo version published.'}`
              : `Architect #${started.architect} ended without an answer (${settled.reason ?? 'unanswered'}).`,
          )
        },
      }),
    ],
  })
