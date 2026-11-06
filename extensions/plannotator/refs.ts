/** Plannotator sessions in the browser: what runs, and the actions that start and stop them. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * One repository to review: a directory, or a conversation's worktree; `base` is what it is compared against. With `ref`
 * the committed state of that branch, tag or commit is reviewed, straight from Git, whatever the checkout holds.
 */
export type ReviewItem = {
  /** A directory inside a Git repository. */
  repo?: string
  /** A conversation whose worktree to review (its branch against its target unless `base` says otherwise). */
  conversation?: number
  /** A branch, tag or commit to review instead of the working tree; its changes since the merge base with `base`. */
  ref?: string
  /** A branch, tag or commit to compare against; by default the worktree's target, else `origin`'s default branch. */
  base?: string
}

/** One repository of a `{ branch, repos }` review, with its own base when `origin`'s default branch is not it. */
export type BranchRepo = { repo: string; base?: string }

/**
 * `combined`: one fixed patch of every repository against its own base, committed work included. `live`: Plannotator's
 * own view of a folder holding the repositories, with only their uncommitted changes and last commits. A single
 * repository is always `live`, with Plannotator's full comparison picker.
 */
export type ReviewMode = 'combined' | 'live'

/** One repository as the session shows it: its path prefix, where it lives, the ref reviewed (else its working tree) and its base. */
export type SessionRepo = { name: string; path: string; ref?: string; base?: string }

export type Session = {
  id: string
  /** Who receives the result: the conversation that started the review. */
  conversation: number
  title: string
  mode: ReviewMode | 'single'
  repos: SessionRepo[]
  state: 'starting' | 'running' | 'approved' | 'annotated' | 'dismissed' | 'failed' | 'stopped'
  /** The address to open: the Caddy address, else the loopback one. */
  url?: string
  /** The loopback address, for this machine. */
  local?: string
  startedAt: string
  endedAt?: string
  error?: string
}

export type Overview = {
  /** The pinned version and whether its binary is installed. */
  version: string
  installed: boolean
  sessions: Session[]
}

/** No arguments → the pinned version, whether it is installed, and the sessions of this server. */
export const OverviewAction = actionRef<null, Overview>('plannotator', 'overview')
/** User only: no arguments → downloads the pinned binary and checks its SHA-256; returns the version. */
export const InstallAction = actionRef<null, { version: string }>('plannotator', 'install')
/**
 * `{ items?, branch?, repos?, mode?, title? }` → a new session for the calling conversation (the one shown in the UI);
 * its result comes back to that conversation as an input once the user approves or sends feedback. `branch` with `repos`
 * reviews that branch in each repository (local, else `origin/<branch>`) and fails naming every repository without it.
 */
export const StartAction = actionRef<
  {
    items?: ReviewItem[]
    branch?: string
    repos?: BranchRepo[]
    mode?: ReviewMode
    title?: string
  },
  Session
>('plannotator', 'start')
/** `{ id }` → stops a running session; nothing comes back to the conversation. */
export const StopAction = actionRef<{ id: string }, { stopped: string }>('plannotator', 'stop')
