import { join } from 'node:path'
import { expect, it } from 'vitest'
import { projectIdentity, projectKey, remoteKey } from '../lib/project-identity.ts'
import { git } from '../lib/git.ts'
import { temp } from './helpers.ts'

it.each([
  ['git@github.com:o/r.git', 'github.com/o/r'],
  ['ssh://git@github.com/o/r', 'github.com/o/r'],
  ['https://user:tok@github.com/o/r.git', 'github.com/o/r'],
  ['https://github.com/O/R/', 'github.com/o/r'],
  ['https://github.com/HazAT/poe2-rust.git/', 'github.com/hazat/poe2-rust'],
  ['git+ssh://git@github.com/o/my.repo.git\n', 'github.com/o/my.repo'],
])('normalises %s', (remote, key) => {
  expect(projectKey(remote)).toBe(key)
})

it.each([
  ['https://github.com/HazAT/Ultimate.git', 'github.com/hazat/ultimate'],
  ['ssh://git@github.com/HazAT/Ultimate.git', 'github.com/hazat/ultimate'],
  ['git@github.com:HazAT/Ultimate.git', 'github.com/hazat/ultimate'],
  ['ssh://git@git.example.cc/rob/workrig.git', 'git.example.cc/rob/workrig'],
  ['ssh://git@Git.Example.cc:2222/rob/workrig.git', 'git.example.cc/rob/workrig'],
  ['git@git.example.cc:rob/bb-plugin-ultimate.git', 'git.example.cc/rob/bb-plugin-ultimate'],
  ['https://user:tok@gitlab.com:8443/Group/Sub/Repo.git/', 'gitlab.com/group/sub/repo'],
  ['gitlab.com:group/sub/repo', 'gitlab.com/group/sub/repo'],
])('keys any host: %s', (remote, key) => {
  expect(remoteKey(remote)).toBe(key)
})

it.each([
  'https://github.com/o/r/tree/main',
  'https://git.example.cc/o',
  'file:///srv/git/r.git',
  '/srv/git/r.git',
  'C:/repos/r',
  '',
])('has no remote key for %j', (remote) => {
  expect(remoteKey(remote)).toBeUndefined()
})

it.each([
  'git@gitlab.com:o/r.git',
  'https://github.company.com/o/r',
  'https://notgithub.com/o/r',
  'https://github.com/o',
  'https://github.com/o/r/tree/main',
  '/srv/git/r.git',
  '',
])('has no key for %j', (remote) => {
  expect(projectKey(remote)).toBeUndefined()
})

it('reads the origin and oldest root commit, from a worktree too, and nothing without an origin', async () => {
  const main = await temp('ultimate-identity-')
  const worktree = join(await temp('ultimate-identity-worktree-'), 'checkout')
  const commit = (message: string) =>
    git(
      main,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--allow-empty',
      '-m',
      message,
    )
  await git(main, 'init', '-b', 'main')
  expect(await projectIdentity(main)).toBeUndefined()
  await commit('root')
  const root = (await git(main, 'rev-parse', 'HEAD')).trim()
  await commit('second')
  expect(await projectIdentity(main)).toBeUndefined()
  await git(main, 'remote', 'add', 'origin', '/srv/git/r.git')
  expect(await projectIdentity(main)).toBeUndefined()
  await git(main, 'remote', 'set-url', 'origin', 'git@git.example.cc:o/R.git')
  expect((await projectIdentity(main))?.key).toBe('git.example.cc/o/r')
  await git(main, 'remote', 'set-url', 'origin', 'git@github.com:HazAT/Ultimate.git')
  await git(main, 'worktree', 'add', worktree, '-b', 'branch')
  for (const checkout of [main, worktree])
    expect(await projectIdentity(checkout)).toEqual({
      key: 'github.com/hazat/ultimate',
      rootCommit: root,
    })
  expect(await projectIdentity(await temp('ultimate-identity-none-'))).toBeUndefined()
})
