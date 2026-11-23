import { exec } from './exec.ts'
import { meansNone } from './errors.ts'
import { git } from './git.ts'

export type GithubRepo = {
  key: string
  name: string
  url: string
  visibility?: 'public' | 'private' | 'internal'
}

export async function readGithubRepo(key: string): Promise<GithubRepo> {
  const withoutVisibility: GithubRepo = {
    key,
    name: key.slice('github.com/'.length),
    url: `https://${key}`,
  }
  try {
    const { stdout } = await exec(
      'gh',
      ['repo', 'view', withoutVisibility.name, '--json', 'nameWithOwner,visibility'],
      { timeout: 15_000 },
    )
    const { nameWithOwner, visibility } = JSON.parse(stdout) as Record<string, unknown>
    const lower = typeof visibility === 'string' ? visibility.toLowerCase() : undefined
    return {
      ...withoutVisibility,
      name: typeof nameWithOwner === 'string' ? nameWithOwner : withoutVisibility.name,
      visibility:
        lower === 'public' || lower === 'private' || lower === 'internal' ? lower : undefined,
    }
  } catch {
    return withoutVisibility
  }
}

export function remoteKey(remote: string): string | undefined {
  const trimmed = remote.trim()
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.*)$/.exec(trimmed)
  const url = scp ? undefined : URL.parse(trimmed)
  const host = (scp ? scp[1] : url?.hostname)?.toLowerCase()
  const path = (scp ? scp[2] : url?.pathname)?.split('/').filter(Boolean)
  if (!host || !path) return undefined
  path.push(path.pop()?.replace(/\.git$/i, '') ?? '')
  if (path.length < 2 || !path.every((part) => /^[\w.-]+$/.test(part))) return undefined
  if (host === 'github.com' && path.length !== 2) return undefined
  return [host, ...path].join('/').toLowerCase()
}

export function projectKey(remote: string): string | undefined {
  const key = remoteKey(remote)
  return key?.startsWith('github.com/') ? key : undefined
}

export const githubRepo = (projectRoot: string) =>
  git(projectRoot, 'remote', 'get-url', 'origin').then(projectKey).catch(meansNone)

export async function projectIdentity(
  root: string,
): Promise<{ key: string; rootCommit: string } | undefined> {
  try {
    const key = remoteKey(await git(root, 'remote', 'get-url', 'origin'))
    if (!key) return undefined
    const rootsNewestFirst = (await git(root, 'rev-list', '--max-parents=0', 'HEAD')).split('\n')
    const rootCommit = rootsNewestFirst.at(-1)!
    return { key, rootCommit }
  } catch {
    return undefined
  }
}
