import { readdir, realpath } from 'node:fs/promises'
import { exec } from './exec.ts'

/** Where and how long a git command runs; defaults: 30 seconds, 1 MiB of output. `timeout: 0` waits indefinitely. */
export type GitOptions = { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal }

/** Runs a program to its end in `options.cwd`, like `exec`; the exec extension passes one that routes by directory. */
export type Run = (
  file: string,
  args: string[],
  options: GitOptions & { maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>

/** `git` over `run`. */
export const gitWith =
  (run: Run) =>
  async (cwd: string | GitOptions, ...args: string[]) => {
    const options = typeof cwd === 'string' ? { cwd } : cwd
    const { stdout } = await run('git', args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      ...options,
    })
    return stdout.trim()
  }

/** Run git in `cwd` and return its trimmed stdout; a failure rejects with execFile's error, stderr in its message. */
export const git = gitWith(exec)
/** A `git` function: this one, or the exec service's that runs where the directory lives. */
export type Git = typeof git

export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'

/** Whether the repository holding `cwd` (or `cwd` itself, outside Git) has nothing in it but `.git`; `gitIn` runs Git. */
export async function empty(cwd: string, gitIn: Git) {
  const top = await gitIn(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git the folder itself is what a new repository would hold.
    () => cwd,
  )
  return (await readdir(top)).every((name) => name === '.git')
}

/** The checkout and branch an isolate of `cwd` would branch from, or why there is none; `gitIn` runs Git. */
export async function isolatable(
  cwd: string,
  gitIn: Git,
): Promise<{ source: string; target: string } | { reason: string }> {
  const top = await gitIn(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git there is nothing to branch from; the reason says so.
    () => undefined,
  )
  if (!top) return { reason: noRepository }
  const source = await realpath(top)
  const target = await gitIn(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (!target) return { reason: 'Isolation needs a checked-out branch' }
  if (!(await gitIn(source, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    return { reason: noCommit }
  // A preview lands on its own branch, never on the branch of the checkout it previews.
  const preview = process.env.ULTIMATE_PREVIEW_BRANCH
  const project = process.env.ULTIMATE_PROJECT
  if (
    preview &&
    project &&
    source === (await realpath(await gitIn(project, 'rev-parse', '--show-toplevel')))
  )
    return { source, target: preview }
  return { source, target }
}
