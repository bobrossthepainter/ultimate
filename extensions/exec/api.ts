/**
 * Exec: runs programs, Git and Pi's execution environment where a working directory lives, on this machine unless an
 * extension routes its root elsewhere. Core tier.
 */
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { defineApi } from '../../shared/extension-api.ts'
import type { GitOptions } from '../../lib/git.ts'
import type { Group, spawnGroup } from '../../lib/process-group.ts'
import type { execFile } from '../../lib/spawn.ts'
import type { TargetInfo } from './refs.ts'

/** How `run` runs: execFile's options without `cwd`, which every call names first. */
export type RunOptions = Omit<NonNullable<Parameters<typeof execFile>[2]>, 'cwd'>
/** How `start` starts: spawnGroup's options without `cwd`. */
export type StartOptions = Omit<Parameters<typeof spawnGroup>[2], 'cwd'>

/** Where commands for a directory run: the built-in `local` target, or one an `exec.protocol` provider registers. */
export type ExecTarget = {
  /** The protocol that runs it: `local`, or the name the provider gives it. */
  protocol: string
  id: string
  /** Every directory at or below this absolute path runs on this target. */
  root: string
  /** `shared`: this machine sees the target's files at the same paths; `remote`: only the target does. */
  files: 'shared' | 'remote'
  /** The protocol's own settings for this target. */
  config: unknown
}

/** One way of running commands, given the target `resolve` picked. */
export type ExecProtocol = {
  /** Run to its end; resolves stdout and stderr, rejects like execFile with them attached. */
  run(
    target: ExecTarget,
    cwd: string,
    file: string,
    args: readonly string[],
    options?: RunOptions,
  ): Promise<{ stdout: string; stderr: string }>
  /** Start a long-running program as its own process group, streamed and stoppable like spawnGroup. */
  start(
    target: ExecTarget,
    cwd: string,
    file: string,
    args: string[],
    options?: StartOptions,
  ): Group
  /** Pi's execution environment (shell and file system) in `cwd`, for the agent's tools. */
  env(target: ExecTarget, cwd: string): ExecutionEnv
  /** The target in one line for people (`local Node`, `user@host:port`); never a secret or a key's path. */
  describe(target: ExecTarget): string
}

export type ExecService = {
  /** The target owning `cwd`: the registered one with the longest root containing it, else `local`. */
  resolve: (cwd: string) => ExecTarget
  /** Run `file` in `cwd` to its end, like execFile: resolves stdout and stderr. */
  run: (
    cwd: string,
    file: string,
    args: readonly string[],
    options?: RunOptions,
  ) => Promise<{ stdout: string; stderr: string }>
  /** Start `file` in `cwd` as its own process group, like spawnGroup. */
  start: (cwd: string, file: string, args: string[], options?: StartOptions) => Group
  /** Run git in `cwd` and return its trimmed stdout, like `git` from `lib/git.ts`. */
  git: (cwd: string | GitOptions, ...args: string[]) => Promise<string>
  /** Pi's execution environment in `cwd`, as the agent's tools get it. */
  env: (cwd: string) => ExecutionEnv
  /** The target owning `cwd`, as its protocol describes it, for the UI. */
  describe: (cwd: string) => TargetInfo
}
/** Run commands where a directory lives; `need` it for work in a project or worktree, never for host-local work. */
export const Exec = defineApi<ExecService>()('exec')

/** A protocol with the targets it serves. */
export type ExecTargets = ExecProtocol & {
  /** The targets to route to this protocol now; read at every `resolve`. */
  targets(): readonly ExecTarget[]
}
/** The extension point another extension fills to run a project's directories somewhere else; exec wants it. */
export const Protocol = defineApi<ExecTargets>()('exec.protocol')
export const tier = 'core'
