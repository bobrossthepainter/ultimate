import { realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
// oxlint-disable-next-line no-restricted-imports -- the core's process-safe lock, the one update holds on the same clone
import { acquireLock } from '../../server/lock.ts'
import { implementAction } from '../../lib/actions.ts'
import { compareUrl } from '../../lib/compare.ts'
import { exec } from '../../lib/exec.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { projectKey } from '../../lib/project-identity.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { PauseApi } from '../pause/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { CheckAction, MergeAction, StateAction } from './refs.ts'
import type { UpstreamState } from './refs.ts'

/** The remote of the repository this one was forked from; without it the extension does nothing. */
const REMOTE = 'upstream'
/** How often the clone is compared with upstream locally; upstream itself is fetched at most hourly. */
export const TICK = 5 * 60_000
export const FETCH_EVERY = 60 * 60_000
/** What the summary model reads: the range's commit messages, never diffs, clipped. */
const SUMMARY_INPUT_CAP = 12_000
const SUMMARY_SYSTEM = `You summarize new upstream commits of Ultimate, a coding agent app, for the user of a fork of it.
You get the commit messages, newest first. Answer with 2 to 4 lines, one per notable change, most useful first, each
under 90 characters, in plain language about what the user gets ("Review surface: comment on diff lines and send them
to an agent"). Group small fixes into one line. No bullets, numbering, commit hashes or preamble.`

export type Git = (...args: string[]) => Promise<string>

/** Git in `root`, never prompting: an HTTPS fetch without a login must fail rather than hang a background check. */
export const gitIn =
  (root: string): Git =>
  async (...args) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      return (await exec('git', args, { cwd: root, env, timeout: 120_000 })).stdout.trim()
    } catch (error) {
      const { stderr = '' } = error as { stderr?: string }
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`, { cause: error })
    }
  }

/** `name` inside the clone's git directory, shared by every Ultimate on the clone. */
async function gitPath(git: Git, root: string, name: string) {
  const path = await git('rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(root, path)
}

/** When upstream was last fetched by any Ultimate on the clone (the stamp's mtime), or undefined before the first. */
export async function fetchedAt(git: Git, root: string) {
  return stat(await gitPath(git, root, 'ultimate-upstream-fetched')).then(
    (info) => info.mtimeMs,
    () => undefined,
  )
}

/**
 * Fetch upstream when its last fetch is older than `FETCH_EVERY`, or always with `force`; the error of a failed
 * fetch, else undefined. `--no-write-fetch-head`: the update extension times its hourly origin fetch by `FETCH_HEAD`'s
 * mtime, so an upstream fetch that wrote it would keep origin from ever being fetched (#9593).
 */
export async function fetchIfDue(git: Git, root: string, now: number, force = false) {
  const last = await fetchedAt(git, root)
  if (!force && last !== undefined && now - last < FETCH_EVERY) return undefined
  try {
    await git('fetch', '--quiet', '--no-write-fetch-head', REMOTE)
    await writeFile(await gitPath(git, root, 'ultimate-upstream-fetched'), '')
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The clone against `upstream/<default branch>` as of the last fetch; `off` without an upstream remote. */
export async function compare(
  git: Git,
  root: string,
): Promise<
  Omit<UpstreamState, 'merge' | 'summary' | 'compare' | 'error'> & { remoteHead?: string }
> {
  const none = { root, behind: 0, ahead: 0, commits: [] }
  if (!(await git('remote').catch(() => '')).split('\n').includes(REMOTE))
    return { ...none, off: true }
  const at = await fetchedAt(git, root)
  const base = { ...none, ...(at !== undefined ? { fetchedAt: at } : {}) }
  const tracking = await git('symbolic-ref', '--short', `refs/remotes/${REMOTE}/HEAD`).catch(
    // Not fetched yet, or fetched without its default branch: the refusal says how to set it.
    () => '',
  )
  if (!tracking)
    return {
      ...base,
      refused: `${REMOTE} has no default branch; run git remote set-head ${REMOTE} --auto`,
    }
  const branch = tracking.slice(REMOTE.length + 1)
  const [ahead = 0, behind = 0] = (
    await git('rev-list', '--left-right', '--count', `HEAD...${tracking}`)
  )
    .split(/\s+/)
    .map(Number)
  const current = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  // A refusal matters only with something to merge: a branch worktree that has upstream's commits is fine.
  const state = {
    ...base,
    branch,
    ahead,
    behind,
    ...(behind && current !== branch
      ? { refused: `${current || 'a detached HEAD'} is checked out, not ${branch}` }
      : {}),
  }
  if (!behind) return state
  const log = await git('log', '-5', '--format=%h%x09%s', `HEAD..${tracking}`)
  return {
    ...state,
    remoteHead: await git('rev-parse', tracking),
    commits: log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split('\t')
        return { sha, subject: subject.join('\t') }
      }),
  }
}

/** The answer's lines, at most 4, without bullets or numbering. */
const summaryLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)

/**
 * The summary of `range`: the cached one when `file` holds it, else asked once with the commit messages and cached
 * (an empty answer too, so a failing model is not asked again for the range); without `ask` only the cache is read.
 */
async function summaryFor(
  file: string,
  range: string,
  log: () => Promise<string>,
  ask?: (input: string) => Promise<string | undefined>,
) {
  const cached = await readJson<{ range?: string; lines?: string[] }>(file, {})
  if (cached.range === range) return cached.lines?.length ? cached.lines : undefined
  if (!ask) return undefined
  const text = await ask((await log()).slice(0, SUMMARY_INPUT_CAP)).catch(
    // No summary model, or it failed: the commit list stands in for the summary.
    () => undefined,
  )
  const lines = text === undefined ? [] : summaryLines(text)
  await writeJson(file, { range, lines })
  return lines.length ? lines : undefined
}

/**
 * Run `work` holding the clone-wide lock update also holds (`.git/ultimate-update.lock`), so no two fetches of one
 * clone overlap across the Ultimates on it; undefined without running while another holds it.
 */
async function withLock<T>(git: Git, root: string, work: () => Promise<T>) {
  let held: Awaited<ReturnType<typeof acquireLock>>
  try {
    held = await acquireLock(await gitPath(git, root, 'ultimate-update.lock'), { pid: process.pid })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Ultimate core already owns'))
      return undefined
    throw error
  }
  try {
    return await work()
  } finally {
    await held.close()
  }
}

/** Ask the summary model once with the range's commit messages; undefined without one. */
async function askModel(host: ExtensionHost, input: string) {
  const conversations = host.need(ConversationsApi)
  const model = await conversations.summaryModel()
  if (!model) return undefined
  const response = await conversations.askSummaryModel(
    host.modelRuntime,
    SUMMARY_SYSTEM,
    input,
    AbortSignal.timeout(60_000),
    { model },
  )
  return response.stopReason === 'stop' ? response.text : undefined
}

/** Why a merge must wait: the lander is landing into the clone (it moves the same branch). */
async function landing(host: ExtensionHost) {
  let index
  try {
    index = await host
      .harness()
      .snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context)
  } catch {
    // Storage is closed (a core swap): nothing lands from this home meanwhile.
    return undefined
  }
  const root = await realpath(host.ultimateRoot)
  return index?.queue.some((entry) => entry.source === root && entry.state === 'landing')
    ? 'The lander is landing into this clone'
    : undefined
}

/** Whether the clone is the project: only there can a branch's landing merge upstream into it. */
const isProject = async (host: ExtensionHost) =>
  (await realpath(host.ultimateRoot)) === (await realpath(host.projectRoot))

const preview = () => Boolean(process.env.ULTIMATE_INSTANCE_OWNER)

type Shared = {
  ticking: Promise<void> | undefined
  checking: Promise<void> | undefined
  latest: UpstreamState | undefined
}

/** Shared across reloads: a reload installs the new facet before the old one closes, and only one tick may run. */
const shared = (host: ExtensionHost) =>
  host.resource<Shared>('upstream-sync.state', () => ({
    ticking: undefined,
    checking: undefined,
    latest: undefined,
  }))

/**
 * Compare the clone with upstream and keep the result for `state`. A `check` fetches when due (always with `force`)
 * and summarizes a new range once, under the clone's lock; a plain refresh only reads.
 */
async function refresh(host: ExtensionHost, check: boolean, force = false) {
  const root = host.ultimateRoot
  const git = gitIn(root)
  const before = await compare(git, root)
  if (before.off) {
    shared(host).latest = { root, off: true, behind: 0, ahead: 0, commits: [] }
    return
  }
  const summaryFile = await gitPath(git, root, 'ultimate-upstream-summary.json')
  const summarize = async (asking: boolean) => {
    const { remoteHead } = await compare(git, root)
    if (!remoteHead) return undefined
    const head = await git('rev-parse', 'HEAD')
    return summaryFor(
      summaryFile,
      `${head}..${remoteHead}`,
      () => git('log', '--format=%s%n%n%b', `${head}..${remoteHead}`),
      asking ? (input) => askModel(host, input) : undefined,
    )
  }
  const checked = check
    ? await withLock(git, root, async () => {
        const error = await fetchIfDue(git, root, Date.now(), force)
        await summarize(true)
        return { error }
      })
    : undefined
  const error = checked ? checked.error : shared(host).latest?.error
  const { remoteHead, ...state } = await compare(git, root)
  const summary = await summarize(false)
  const repo = remoteHead
    ? projectKey(await git('remote', 'get-url', REMOTE).catch(() => ''))
    : undefined
  const refused = state.refused ?? (state.behind ? await landing(host) : undefined)
  shared(host).latest = {
    ...state,
    ...(summary ? { summary } : {}),
    ...(repo && remoteHead
      ? { compare: compareUrl(repo, await git('rev-parse', 'HEAD'), remoteHead) }
      : {}),
    ...(refused ? { refused } : {}),
    ...(state.behind && !refused && (await isProject(host)) ? { merge: true as const } : {}),
    ...(error ? { error } : {}),
  }
}

async function currentState(host: ExtensionHost): Promise<UpstreamState> {
  if (preview()) return { root: host.ultimateRoot, off: true, behind: 0, ahead: 0, commits: [] }
  if (!shared(host).latest) await refresh(host, false)
  return shared(host).latest!
}

/** What @ultimate reads when the user asks for the merge. */
const mergeInput = (state: UpstreamState) => {
  const { branch, root, ahead, behind } = state
  return [
    `Update with @ultimate: ${branch} in ${root} lacks ${behind} new ${behind === 1 ? 'commit' : 'commits'} on ${REMOTE}/${branch} and has ${ahead} of its own (the fork's divergences).`,
    `Start a coordinator branch that merges ${REMOTE}/${branch} into ${branch} following the project's merge-upstream skill: git fetch ${REMOTE}, then a normal git merge ${REMOTE}/${branch}, never a rebase, reset or force push.`,
    'It resolves the conflicts it can resolve safely, sends the unclear ones back as decisions, runs the checks and the tests covering the conflicts, and lands the merge with workspace submit.',
    'Afterwards the update item asks for any restart the upstream changes need.',
  ].join('\n')
}

export default function upstreamSync(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(WorkspacesApi)
  host.need(ConversationsApi)
  host.need(SubagentsApi)
  host.want(PauseApi)
  // A preview never fetches: it must not race the host on the same clone.
  if (preview()) return defineExtension({ name: 'upstream-sync' })
  const state = shared(host)
  const tick = () => {
    // Paused: no fetch starts until Play; the next tick after it catches up.
    if (host.want(PauseApi)?.paused()) return
    state.ticking ??= refresh(host, true)
      .catch((error: unknown) => host.notice(`Upstream check: ${String(error)}`))
      .finally(() => {
        state.ticking = undefined
      })
  }
  const start = setTimeout(tick, 30_000)
  const timer = setInterval(tick, TICK)
  host.onClose(async () => {
    clearTimeout(start)
    clearInterval(timer)
    await state.ticking
  })
  return defineExtension({ name: 'upstream-sync' })
}

export const userActions = ['merge']

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => currentState(host)),
  check: implementAction(CheckAction, async (_args, { host }) => {
    if (preview()) return currentState(host)
    const state = shared(host)
    // A background tick may be mid-check without forcing: let it finish, then fetch now. A second click joins.
    await state.ticking
    state.checking ??= refresh(host, true, true).finally(() => {
      state.checking = undefined
    })
    await state.checking
    return state.latest!
  }),
  merge: implementAction(MergeAction, async (_args, { host }) => {
    if (preview()) throw new Error('A preview never merges into the clone it runs from')
    await refresh(host, false)
    const latest = shared(host).latest!
    if (!latest.merge)
      throw new Error(latest.refused ?? `${latest.branch} has nothing new from ${REMOTE}`)
    const git = gitIn(host.ultimateRoot)
    const head = await git('rev-parse', 'HEAD')
    const remoteHead = await git('rev-parse', `${REMOTE}/${latest.branch}`)
    const id = await host.need(SubagentsApi).standing('ultimate', context)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content: mergeInput(latest),
        // One ask per range: a second click while @ultimate is on it adds nothing.
        requestId: `upstream-merge:${head}..${remoteHead}`,
        whenBusy: 'followUp',
      },
      context,
    )
    return { id }
  }),
}
