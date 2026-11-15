import { readdir, realpath } from 'node:fs/promises'
import { exec } from './exec.ts'
import { meansNone } from './errors.ts'

export type GitOptions = { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal }

export type Run = (
  file: string,
  args: string[],
  options: GitOptions & { maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>

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

export const git = gitWith(exec)
export type Git = typeof git

export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'

export async function empty(cwd: string, gitIn: Git) {
  const repositoryRootOrNewRepositoryFolder = await gitIn(
    cwd,
    'rev-parse',
    '--show-toplevel',
  ).catch(() => cwd)
  return (await readdir(repositoryRootOrNewRepositoryFolder)).every((name) => name === '.git')
}

export async function isolatable(
  cwd: string,
  gitIn: Git,
): Promise<{ source: string; target: string } | { reason: string }> {
  const top = await gitIn(cwd, 'rev-parse', '--show-toplevel').catch(meansNone)
  if (!top) return { reason: noRepository }
  const source = await realpath(top)
  const target = await gitIn(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (!target) return { reason: 'Isolation needs a checked-out branch' }
  if (!(await gitIn(source, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    return { reason: noCommit }
  const previewLandingBranch = process.env.ULTIMATE_PREVIEW_BRANCH
  const project = process.env.ULTIMATE_PROJECT
  if (
    previewLandingBranch &&
    project &&
    source === (await realpath(await gitIn(project, 'rev-parse', '--show-toplevel')))
  )
    return { source, target: previewLandingBranch }
  return { source, target }
}
