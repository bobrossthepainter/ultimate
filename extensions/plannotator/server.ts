import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineEntry, defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { arr, int, obj, opt, str } from '@earendil-works/pi-schema'
import { implementAction } from '../../lib/actions.ts'
import {
  closeOutput,
  identify,
  spawnGroup,
  stopGroup,
  sweepPidFiles,
} from '../../lib/process-group.ts'
import type { Group } from '../../lib/process-group.ts'
import { strEnum } from '../../lib/schema.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { CaddyApi } from '../caddy/api.ts'
import { Exec } from '../exec/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { InstallAction, OverviewAction, StartAction, StopAction } from './refs.ts'
import type { Overview, ReviewItem, Session, SessionRepo } from './refs.ts'

/**
 * The pinned release and its SHA-256 per platform, from the release's `.sha256` files. A newer Plannotator may change
 * the flags and environment below (`--base` and `DIRECTORY` are newer than its docs), so update both together.
 */
export const VERSION = 'v0.28.51'
const BINARIES: Record<string, string> = {
  'linux-x64': 'b152a4c227fae72a619175c99ae897f44ac467c1cd7aa8c66119427ad7076f6d',
  'linux-arm64': '5b28d2070ba142b79a52deff488448f191da3230214a13798091f9a45c23a8df',
  'darwin-arm64': '0489448067d490d270dc782d754c3e80890aac424d10059cedaba404524d6aa0',
  'darwin-x64': '1ab6ed11fb6feb85279e05e01f2e4de5971f06a17fd75d906bb0c4efa6c33e65',
}
/** Session ports, one per running session; Caddy serves each at `https://<domain>:<PUBLISH + n>`. */
const PORTS = [19432, 19433, 19434, 19435]
const PUBLISH = 9480
/** A finished session's card keeps its result this long; the newest few stay listed. */
const KEEP = 20

const paths = (userHome: string) => {
  const dir = join(userHome, '.ultimate/plannotator')
  return {
    dir,
    // PLANNOTATOR_COMMAND names another binary; tests point it at a stub.
    binary: process.env.PLANNOTATOR_COMMAND ?? join(dir, `plannotator-${VERSION}`),
    data: join(dir, 'data'),
    /**
     * One folder per server process, `sessions/<pid>-<start>` (`identify`, so a reused pid is told apart), holding its
     * sessions' pid files and folders.
     */
    owners: join(dir, 'sessions'),
    sessions: join(dir, 'sessions', owner()),
  }
}

/** Who process `pid` is, as a folder name: its pid and start time, or its pid alone once it is gone. */
const ownerOf = (pid: number) => `${pid}-${(identify(pid) ?? 'gone').replace(/[^A-Za-z0-9]/g, '')}`
let self: string | undefined
const owner = () => (self ??= ownerOf(process.pid))

/** The result Plannotator prints with `--json` when the user decides; `message` is its Markdown feedback. */
type Decision = { decision: 'approved' | 'annotated' | 'dismissed'; message?: string }
/** The review result as its recipient's input: card.tsx renders it, the model reads `message`. */
export type PlannotatorResult = {
  session: string
  title: string
  decision: 'approved' | 'annotated'
  message: string
  url?: string
}
export const ResultEntry = defineEntry<PlannotatorResult>('plannotator.result')

/**
 * A session and what it holds until `teardown` has freed it: its port (taken until then, so no new session reuses it
 * early), its process group, its Caddy route and its folder. `ended` is set once, by whoever ends it first.
 */
type Running = Session & {
  port: number
  group?: Group
  folder?: string
  published?: number
  /**
   * The startup's acquisitions (Caddy route, folder, process) while they are under way: teardown waits for them to
   * settle, so whatever they made after Stop is removed too. It never rejects.
   */
  acquiring?: Promise<void>
  ended?: Promise<void>
  freed?: boolean
}

/**
 * The sessions of this process: they outlive a reload of this facet, and stop with the server. A crash leaves pid
 * files under `sessions/`; the next start stops what they name and removes the folders.
 */
function state(host: ExtensionHost) {
  return host.resource('plannotator', () => {
    const sessions = new Map<string, Running>()
    host.onClose(async () => {
      // Caddy drops this process's published routes itself at shutdown, after the services are gone.
      await Promise.all([...sessions.values()].map((session) => finish(host, session, 'stopped')))
    })
    return sessions
  })
}

/**
 * What crashed servers left: the process groups and folders under `sessions/<pid>` of every server whose process is
 * gone. Every Ultimate of this user shares the folder, so a live server's sessions are never touched. Once per process,
 * before it starts any session (`start` awaits it).
 */
function swept(host: ExtensionHost) {
  return host.resource('plannotator:sweep', async () => {
    const { owners } = paths(host.userHome)
    const folders = await readdir(owners).catch(
      // No folder yet: nothing was ever left.
      () => [] as string[],
    )
    for (const name of folders) {
      const pid = Number(name.split('-')[0])
      if (!Number.isSafeInteger(pid) || ownerOf(pid) === name) continue
      await sweepPidFiles(join(owners, name))
      await rm(join(owners, name), { recursive: true, force: true })
    }
  })
}

/** A string argument that cannot be read as an option by git or Plannotator. */
function plain(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a non-empty string`)
  if (value.startsWith('-') || /[\0\n\r]/.test(value)) throw new Error(`${name} is not a valid ref`)
  return value.trim()
}

/** Where an item lives and what it is compared against: the worktree's target, else the repository's default branch. */
async function locate(host: ExtensionHost, item: ReviewItem) {
  const exec = host.need(Exec)
  let dir: string | undefined
  let base = item.base === undefined ? undefined : plain(item.base, 'base')
  if (item.conversation !== undefined) {
    if (!Number.isSafeInteger(item.conversation) || item.conversation < 1)
      throw new Error('conversation must be a conversation id')
    const workspace = await host
      .need(WorkspacesApi)
      .get(item.conversation as ConversationId, context)
    if (workspace?.state === 'ready') {
      dir = workspace.path
      base ??= workspace.target
    } else dir = host.projectRoot
  }
  if (item.repo !== undefined) {
    if (typeof item.repo !== 'string' || !item.repo) throw new Error('repo must be a path')
    dir = isAbsolute(item.repo) ? item.repo : resolve(host.projectRoot, item.repo)
  }
  if (!dir) throw new Error('Each item names a repo or a conversation')
  const top = await exec.git(dir, 'rev-parse', '--show-toplevel').catch(() => {
    throw new Error(`${dir} is not inside a Git repository`)
  })
  base ??= await defaultBranch(host, top)
  if (base)
    await exec
      .git(top, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`)
      .catch(() => {
        throw new Error(`${base} is not a commit in ${top}`)
      })
  return { path: top, base }
}

/** `origin`'s default branch as known locally, else `main` or `master` when they exist. */
async function defaultBranch(host: ExtensionHost, top: string) {
  const git = (...args: string[]) =>
    host
      .need(Exec)
      .git(top, ...args)
      .catch(
        // A missing ref is the answer "not this one".
        () => '',
      )
  const head = await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
  if (head) return head
  for (const name of ['main', 'master'])
    if (await git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`)) return name
  return undefined
}

/** Distinct, readable path prefixes: a repository's folder name, numbered past every name already given. */
export function names(dirs: string[]) {
  const used = new Set<string>()
  return dirs.map((dir) => {
    const name = basename(dir).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo'
    let label = name
    for (let count = 2; used.has(label); count++) label = `${name}-${count}`
    used.add(label)
    return label
  })
}

/**
 * Every repository's change since its base, committed, staged, unstaged and untracked, in one patch whose paths start
 * with the repository's name, as Plannotator's multi-repository view writes them.
 */
async function combinedPatch(host: ExtensionHost, repos: SessionRepo[]) {
  const exec = host.need(Exec)
  const parts: string[] = []
  for (const repo of repos) {
    const prefix = [`--src-prefix=a/${repo.name}/`, `--dst-prefix=b/${repo.name}/`]
    const options = { timeout: 60000, maxBuffer: 64 * 1024 * 1024 }
    const base = repo.base
      ? await exec.git(repo.path, 'merge-base', '--end-of-options', repo.base, 'HEAD')
      : undefined
    const tracked = await exec.run(
      repo.path,
      'git',
      ['diff', '--no-color', '--no-ext-diff', '-M', ...prefix, ...(base ? [base] : ['HEAD'])],
      options,
    )
    parts.push(tracked.stdout)
    const untracked = await exec.run(
      repo.path,
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      options,
    )
    for (const path of untracked.stdout.split('\0').filter(Boolean)) {
      const added = await exec
        .run(
          repo.path,
          'git',
          ['diff', '--no-index', '--no-color', ...prefix, '--', '/dev/null', path],
          options,
        )
        .catch((error: { code?: unknown; stdout?: string }) => {
          // `--no-index` exits 1 when the files differ, which a new file always does.
          if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }
          throw error
        })
      parts.push(added.stdout)
    }
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * Starts `plannotator review` for `session` and returns once it serves, or throws its output. Once it exits, its full
 * stdout is read and the session finishes with the decision it printed.
 */
async function launch(host: ExtensionHost, session: Running, args: string[], cwd: string) {
  const files = paths(host.userHome)
  await mkdir(files.data, { recursive: true, mode: 0o700 })
  // Plannotator reads `updateCheck` only from its config: off, so a session asks GitHub for no release record.
  const config = join(files.data, 'config.json')
  if (!existsSync(config)) await writeFile(config, '{ "updateCheck": false }\n')
  const { PLANNOTATOR_ALLOWED_HOSTS: _inherited, ...parent } = process.env
  const env = {
    ...parent,
    BROWSER: 'none',
    PLANNOTATOR_DATA_DIR: files.data,
    PLANNOTATOR_PORT: String(session.port),
    PLANNOTATOR_SHARE: 'disabled',
    PLANNOTATOR_AI: 'disabled',
    PLANNOTATOR_GIT_REMOTE_CHECK: '0',
    // Plannotator refuses a Host header other than its own: the Caddy domain only when the session is published there.
    ...(session.published !== undefined && {
      PLANNOTATOR_ALLOWED_HOSTS: new URL(session.url!).hostname,
    }),
  }
  // Stopped while the folders were made: start nothing.
  if (session.ended) throw new Error('The Plannotator session was stopped while it started')
  // Plannotator is Ultimate's own host-local tool, like Caddy: it serves on this machine's loopback for its browser. Its
  // pid file lets the next start stop it after a crash of this server.
  await mkdir(files.sessions, { recursive: true })
  if (session.ended) throw new Error('The Plannotator session was stopped while it started')
  const group = spawnGroup(files.binary, ['review', '--json', ...args], {
    cwd,
    env,
    grace: 3000,
    pidFile: join(files.sessions, `${session.id}.pid`),
  })
  session.group = group
  let stdout = ''
  let output = ''
  group.child.stdout.setEncoding('utf8')
  group.child.stderr.setEncoding('utf8')
  group.child.stdout.on('data', (chunk: string) => (stdout += chunk))
  const ready = Promise.withResolvers<void>()
  group.child.stderr.on('data', (chunk: string) => {
    output = (output + chunk).slice(-4000)
    if (/session ready/i.test(output)) ready.resolve()
  })
  group.child.once('error', (error) => ready.reject(error))
  group.child.once('exit', () => {
    ready.reject(new Error(output.trim() || 'Plannotator exited before it served'))
    // The exit can come before the last of stdout: the decision is read once the pipes have closed.
    void closeOutput(group)
      .then(() => {
        const line = stdout.trim().split('\n').at(-1)
        let decision: Decision | undefined
        try {
          decision = line ? (JSON.parse(line) as Decision) : undefined
        } catch {
          // Not its JSON record: the session failed, and its output says why.
        }
        return finish(host, session, decision?.decision ?? 'failed', decision, output)
      })
      .catch((error: unknown) => host.notice(`Plannotator: ${String(error)}`))
  })
  const timer = setTimeout(
    () => ready.reject(new Error('Plannotator did not serve within 30 s')),
    30000,
  )
  try {
    await ready.promise
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ends `session` once, whoever comes first (its exit, Stop, a failed start, shutdown): records how it ended, stops its
 * process group, frees its route and folder, and only then gives up its port. Only the exit that ended a running
 * session delivers its decision; after Stop nothing is delivered.
 */
function finish(
  host: ExtensionHost,
  session: Running,
  end: Session['state'],
  decision?: Decision,
  output = '',
) {
  session.ended ??= (async () => {
    const delivers = session.state === 'running' && decision !== undefined
    session.state = end
    session.endedAt = new Date().toISOString()
    if (end === 'failed' && output && !session.error)
      session.error = output.trim().split('\n').slice(-5).join('\n')
    // Also once it exited by itself: stopGroup then only waits for the group and removes the pid file.
    const group = session.group
    if (group?.child.pid !== undefined)
      await stopGroup(group.child.pid, {
        leader: group,
        grace: 3000,
        pidFile: join(paths(host.userHome).sessions, `${session.id}.pid`),
      })
    // Stop during startup: what it is acquiring settles first, so its route, folder and process are known and removed.
    await session.acquiring
    if (session.published !== undefined)
      try {
        await host.want(CaddyApi)?.unpublish(session.published)
      } catch {
        // At shutdown the service is gone; Caddy then drops this process's routes itself.
      }
    if (session.folder) await rm(session.folder, { recursive: true, force: true })
    session.freed = true
    if (delivers) await deliver(host, session, decision)
  })()
  return session.ended
}

/** The result as the input of the conversation that started the review: it steers a busy one, like a typed message. */
async function deliver(host: ExtensionHost, session: Running, decision: Decision) {
  if (decision.decision === 'dismissed') return
  const conversation = await host
    .harness()
    .conversation(session.conversation as ConversationId, context)
  if (!conversation) return
  const result: PlannotatorResult = {
    session: session.id,
    title: session.title,
    decision: decision.decision,
    message: (decision.message ?? '').trim() || 'Approved.',
    ...(session.url && { url: session.url }),
  }
  const heading =
    decision.decision === 'approved'
      ? `The user approved the Plannotator review "${session.title}".`
      : `The user sent Plannotator review feedback on "${session.title}".`
  const content = `${heading}\n\n${result.message}`
  const submission = await conversation.submit(
    { type: 'input', content, entry: { kind: ResultEntry.kind, data: result }, whenBusy: 'steer' },
    context,
  )
  const admitted = await submission.status(context)
  await host.harness().commit(
    (tx) =>
      host.emit(tx, UserInputEvent, {
        conversation: session.conversation,
        kind: 'review',
        ...(admitted.entry === undefined
          ? { submission: submission.id }
          : { entry: admitted.entry }),
        length: content.length,
      }),
    context,
  )
}

async function start(
  host: ExtensionHost,
  conversation: number,
  input: { items?: unknown; mode?: unknown; title?: unknown },
): Promise<Session> {
  const files = paths(host.userHome)
  if (!existsSync(files.binary))
    throw new Error(`Plannotator ${VERSION} is not installed: ⌘K → Install Plannotator.`)
  await swept(host)
  const items = Array.isArray(input.items) ? (input.items as ReviewItem[]) : []
  if (!items.length || items.length > 12) throw new Error('Give 1 to 12 items to review')
  if (input.mode !== undefined && input.mode !== 'combined' && input.mode !== 'live')
    throw new Error("mode is 'combined' or 'live'")
  const mode = input.mode ?? 'combined'
  const located = await Promise.all(items.map((item) => locate(host, item)))
  if (new Set(located.map((repo) => repo.path)).size !== located.length)
    throw new Error('Each repository may appear once')
  const labels = names(located.map((repo) => repo.path))
  const repos = located.map((repo, index) => ({ ...repo, name: labels[index] }))
  const sessions = state(host)
  for (const [id] of [...sessions].filter(([, item]) => item.freed).slice(0, -KEEP))
    sessions.delete(id)
  // A port stays taken until its session is freed, not only while it runs.
  const taken = new Set(
    [...sessions.values()].filter((item) => !item.freed).map((item) => item.port),
  )
  const port = PORTS.find((candidate) => !taken.has(candidate))
  if (port === undefined)
    throw new Error(`${PORTS.length} Plannotator sessions run already; stop one first.`)
  const title =
    typeof input.title === 'string' && input.title.trim()
      ? input.title.trim().slice(0, 120)
      : repos.map((repo) => repo.name).join(', ')
  const local = `http://127.0.0.1:${port}`
  const session: Running = {
    id: randomUUID(),
    conversation,
    title,
    mode: repos.length === 1 ? 'single' : mode,
    // Plannotator's multi-repository view takes no base, so none is shown for it.
    repos: repos.map(({ name, path, base }) => ({
      name,
      path,
      ...(base && (repos.length === 1 || mode === 'combined') && { base }),
    })),
    state: 'starting',
    port,
    local,
    url: local,
    startedAt: new Date().toISOString(),
  }
  sessions.set(session.id, session)
  // Stop during any await below ends the session; each step checks before it goes on.
  const stopped = () => {
    if (session.ended) throw new Error('The Plannotator session was stopped while it started')
  }
  const acquired = Promise.withResolvers<void>()
  session.acquiring = acquired.promise
  try {
    const publish = PUBLISH + PORTS.indexOf(port)
    const url = await host.want(CaddyApi)?.publish(publish, local)
    if (url) {
      session.published = publish
      session.url = url
    }
    stopped()
    let args: string[]
    let cwd: string
    if (session.mode === 'single') {
      const [repo] = repos
      args = [...(repo.base ? ['--base', repo.base] : []), '--title', title, repo.path]
      cwd = repo.path
    } else {
      session.folder = join(files.sessions, session.id)
      await mkdir(session.folder, { recursive: true })
      if (session.mode === 'live') {
        // A folder of links, one per repository: Plannotator follows them and shows each under its name.
        for (const repo of repos) await symlink(repo.path, join(session.folder, repo.name))
        args = ['--title', title, session.folder]
      } else {
        const patch = join(session.folder, 'review.patch')
        await writeFile(patch, await combinedPatch(host, repos))
        args = ['--title', title, '--patch-file', patch]
      }
      cwd = session.folder
    }
    stopped()
    await launch(host, session, args, cwd)
    stopped()
    session.state = 'running'
  } catch (error) {
    session.error ??= String(error instanceof Error ? error.message : error).slice(0, 1000)
    acquired.resolve()
    await finish(host, session, session.ended ? session.state : 'failed')
    throw error
  } finally {
    acquired.resolve()
  }
  return view(session)
}

const view = ({
  group: _group,
  port: _port,
  folder: _folder,
  published: _published,
  ended: _ended,
  freed: _freed,
  ...session
}: Running): Session => session

export const userActions = ['install']
export const pollActions = ['overview']

export const actions: Record<string, ExtensionAction> = {
  overview: implementAction(OverviewAction, (_args, { host }): Overview => ({
    version: VERSION,
    installed: existsSync(paths(host.userHome).binary),
    sessions: [...state(host).values()].map(view).toReversed(),
  })),
  install: implementAction(InstallAction, async (_args, { host }) => {
    const files = paths(host.userHome)
    const platform = `${process.platform}-${process.arch}`
    const sha = BINARIES[platform]
    if (!sha) throw new Error(`No Plannotator release for ${platform}`)
    const url = `https://github.com/backnotprop/plannotator/releases/download/${VERSION}/plannotator-${platform}`
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
    if (!response.ok) throw new Error(`Plannotator download failed (${response.status})`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw new Error(
        'The downloaded Plannotator does not match its pinned SHA-256; not installed.',
      )
    await mkdir(files.dir, { recursive: true, mode: 0o700 })
    const temporary = `${files.binary}.${process.pid}.tmp`
    await writeFile(temporary, bytes)
    await chmod(temporary, 0o755)
    await rename(temporary, files.binary)
    return { version: VERSION }
  }),
  start: implementAction(StartAction, async (args, { host, conversationId }) => {
    if (conversationId === undefined) throw new Error('Start a review from a conversation')
    return start(host, conversationId, (args ?? {}) as Record<string, unknown>)
  }),
  stop: implementAction(StopAction, async (args, { host }) => {
    const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
    const session = typeof id === 'string' ? state(host).get(id) : undefined
    if (!session) throw new Error('No such Plannotator session')
    await finish(
      host,
      session,
      session.state === 'running' || session.state === 'starting' ? 'stopped' : session.state,
    )
    return { stopped: session.id }
  }),
}

export default function plannotator(host: ExtensionHost) {
  swept(host).catch((error: unknown) => host.notice(`Plannotator: ${String(error)}`))
  state(host)
  host.want(CaddyApi)
  return defineExtension({
    name: 'plannotator',
    tools: [
      defineTool({
        name: 'review_with_plannotator',
        description:
          "Open a Plannotator code review for the user: one or more Git repositories, each against its base. Returns the session's address; the user opens it from the card, and their feedback or approval comes back to this conversation as their input. One repository gets Plannotator's live view with its comparison picker. Several get mode 'combined' (default: one fixed patch, each repository since its own base, commits included) or 'live' (Plannotator's own multi-repository view: uncommitted changes and last commits only).",
        parameters: obj({
          items: arr(
            obj({
              repo: opt(
                str({
                  description:
                    'A directory inside a Git repository (absolute, or relative to the project).',
                }),
              ),
              conversation: opt(
                int({
                  minimum: 1,
                  description:
                    'A conversation whose worktree to review, against its target branch.',
                }),
              ),
              base: opt(
                str({
                  description:
                    'Branch, tag or commit to compare against; default: the worktree target, else the default branch.',
                }),
              ),
            }),
            { minItems: 1, maxItems: 12 },
          ),
          mode: opt(strEnum(['combined', 'live'])),
          title: opt(str({ maxLength: 120 })),
        }),
        async execute(args, api) {
          try {
            const session = await start(host, api.conversationId, args)
            return { output: [{ type: 'text', text: JSON.stringify(session) }] }
          } catch (error) {
            return {
              isError: true,
              output: [
                { type: 'text', text: String(error instanceof Error ? error.message : error) },
              ],
            }
          }
        },
      }),
    ],
  })
}
