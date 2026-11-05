import { mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { context } from '../../server/harness.ts'
import { Standing } from '../../extensions/subagents/api.ts'
import { compare, fetchIfDue, gitIn } from '../../extensions/upstream-sync/server.ts'
import { fauxServer, post, sourceCopy, temp } from '../helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const commit = (root: string, ...args: string[]) =>
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', ...args)

/** A fork of `root`: its origin is the fork (current), its upstream has one commit the fork lacks. */
async function fork(home: string, root: string) {
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'add', '-A')
  await commit(root, '-m', 'base')
  const upstream = join(home, 'upstream.git')
  const origin = join(home, 'origin.git')
  await git(home, 'clone', '-q', '--bare', root, upstream)
  await commit(root, '--allow-empty', '-m', 'fork only')
  await git(home, 'clone', '-q', '--bare', root, origin)
  await git(root, 'remote', 'add', 'origin', origin)
  await git(root, 'remote', 'add', 'upstream', upstream)
  const other = join(home, 'other')
  await git(home, 'clone', '-q', upstream, other)
  await commit(other, '--allow-empty', '-m', 'new upstream')
  await git(other, 'push', '-q', 'origin', 'main')
  await git(root, 'fetch', '-q', 'origin')
  await git(root, 'remote', 'set-head', 'origin', 'main')
  await git(root, 'fetch', '-q', 'upstream')
  await git(root, 'remote', 'set-head', 'upstream', 'main')
  return root
}

it('fetches upstream hourly by its own stamp and leaves FETCH_HEAD to update', async () => {
  const home = await temp()
  const root = join(home, 'clone')
  await mkdir(root)
  await writeFile(join(root, 'README.md'), 'x\n')
  await fork(home, root)
  const run = gitIn(root)
  expect(await compare(run, root)).toMatchObject({ branch: 'main', ahead: 1, behind: 1 })

  // Update times its origin fetch by FETCH_HEAD: an upstream fetch must leave it as it was.
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(join(root, '.git/FETCH_HEAD'), old, old)
  expect(await fetchIfDue(run, root, Date.now())).toBeUndefined()
  expect((await stat(join(root, '.git/FETCH_HEAD'))).mtimeMs).toBe(old.getTime())
  const stamp = join(root, '.git/ultimate-upstream-fetched')
  expect((await stat(stamp)).mtimeMs).toBeGreaterThan(old.getTime())

  // Just fetched: not due, so a fetch by a broken remote is not even tried; forced, it reports the failure.
  await git(root, 'remote', 'set-url', 'upstream', join(home, 'missing.git'))
  expect(await fetchIfDue(run, root, Date.now())).toBeUndefined()
  expect(await fetchIfDue(run, root, Date.now(), true)).toMatch(/git fetch failed/)

  // Without an upstream remote the extension is off.
  await git(root, 'remote', 'remove', 'upstream')
  expect(await compare(run, root)).toMatchObject({ off: true })
})

it('asks @ultimate once to merge upstream with the merge-upstream skill', async () => {
  const home = await temp()
  const root = await fork(home, await sourceCopy(home))
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot: root,
    home: join(home, 'state'),
    userHome: home,
  })
  servers.push(server)
  const state = await post(server, '/api/extensions/upstream-sync/actions/state', {})
  expect(state.data.result).toMatchObject({ branch: 'main', ahead: 1, behind: 1, merge: true })
  expect(state.data.result.commits[0].subject).toBe('new upstream')
  for (let click = 0; click < 2; click++) {
    expect((await post(server, '/api/extensions/upstream-sync/actions/merge', {})).status).toBe(200)
    await server.harness.waitForIdle(context)
  }
  const standing = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
  const conversation = (await server.harness.conversation(standing!.ultimate, context))!
  const messages = JSON.stringify((await conversation.context(context)).messages)
  expect(messages.match(/Update with @ultimate: main in /g)).toHaveLength(1)
  expect(messages).toContain("following the project's merge-upstream skill")
  expect(messages).toContain('git merge upstream/main, never a rebase')

  // Update still compares with origin, which the fork keeps current.
  const update = await post(server, '/api/extensions/update/actions/state', {})
  expect(update.data.result).toMatchObject({ behind: 0 })
})
