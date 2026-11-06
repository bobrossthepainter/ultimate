import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { git } from '../lib/git.ts'
import { branchItems } from '../extensions/plannotator/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { apis, temp } from './helpers.ts'

async function repo(path: string) {
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-q', '-b', 'main')
  await git(path, 'config', 'user.email', 'test@example.com')
  await git(path, 'config', 'user.name', 'Test')
  await writeFile(join(path, 'f.txt'), 'base\n')
  await git(path, 'add', '-A')
  await git(path, 'commit', '-q', '-m', 'base')
}

it('finds one branch across repositories, local first, then origin, and names those without it', async () => {
  const home = await temp('ultimate-plannotator-branch-')
  const branch = 'feature/ABC-1'
  // local: has the branch itself. remote: only as origin/<branch>, as a clone that never checked it out. none: neither.
  const local = join(home, 'local')
  await repo(local)
  await git(local, 'branch', branch)
  const upstream = join(home, 'upstream')
  await repo(upstream)
  await git(upstream, 'branch', branch)
  const remote = join(home, 'remote')
  await git(home, 'clone', '-q', upstream, remote)
  const none = join(home, 'none')
  await repo(none)
  const host = { projectRoot: home, ...apis() } as unknown as ExtensionHost

  expect(
    await branchItems(host, branch, [{ repo: local }, { repo: 'remote', base: 'origin/main' }]),
  ).toEqual([
    { repo: local, ref: branch },
    { repo: remote, ref: `origin/${branch}`, base: 'origin/main' },
  ])
  await expect(
    branchItems(host, branch, [{ repo: local }, { repo: none }, { repo: join(home, 'missing') }]),
  ).rejects.toThrow(
    `No branch ${branch} (local or origin/${branch}) in: ${none}, ${join(home, 'missing')}`,
  )
})
