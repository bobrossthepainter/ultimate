import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { git } from '../../lib/git.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, temp, until } from '../helpers.ts'

afterEach(() => vi.unstubAllEnvs())

/**
 * A stand-in for `plannotator review`: it records its arguments, environment and any patch file, says it is ready the
 * way the real one does, and prints the decision it is sent on stdin as the `--json` record.
 */
async function stub(dir: string) {
  const binary = join(dir, 'plannotator')
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const patch = args[args.indexOf('--patch-file') + 1];
fs.writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify({
  args, cwd: process.cwd(), patch: args.includes('--patch-file') ? fs.readFileSync(patch, 'utf8') : undefined,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PLANNOTATOR_') || key === 'BROWSER')),
}));
process.stderr.write('\\n  Plannotator session ready: http://localhost:' + process.env.PLANNOTATOR_PORT + '\\n');
const decide = ${JSON.stringify(join(dir, 'decision.json'))};
const timer = setInterval(() => {
  if (!fs.existsSync(decide)) return;
  clearInterval(timer);
  process.stdout.write(fs.readFileSync(decide, 'utf8') + '\\n');
}, 50);
`,
  )
  await chmod(binary, 0o755)
  return binary
}

async function repo(path: string, change: string) {
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-q', '-b', 'main')
  await git(path, 'config', 'user.email', 'test@example.com')
  await git(path, 'config', 'user.name', 'Test')
  await writeFile(join(path, 'f.txt'), 'base\n')
  await git(path, 'add', '-A')
  await git(path, 'commit', '-q', '-m', 'base')
  await git(path, 'checkout', '-q', '-b', 'feature')
  await writeFile(join(path, 'f.txt'), `base\n${change}\n`)
  await git(path, 'commit', '-qam', 'change')
  await writeFile(join(path, 'new.txt'), 'untracked\n')
}

it('reviews several repositories as one patch and hands the feedback back as the input of its conversation', async () => {
  const home = await temp('ultimate-plannotator-')
  const dir = join(home, 'stub')
  await mkdir(dir)
  vi.stubEnv('PLANNOTATOR_COMMAND', await stub(dir))
  const project = join(home, 'project')
  await mkdir(project)
  await mkdir(join(home, '.ultimate'))
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['plannotator'] } }),
  )
  await repo(join(home, 'alpha'), 'alpha change')
  await repo(join(home, 'beta'), 'beta change')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    const action = (name: string, args: unknown, conversationId?: number) =>
      post(server, `/api/extensions/plannotator/actions/${name}`, { args, conversationId })
    const target = (await post(server, '/api/conversations', { title: 'Asker' })).data.id as number
    const started = await action(
      'start',
      { items: [{ repo: join(home, 'alpha') }, { repo: join(home, 'beta'), base: 'main' }] },
      target,
    )
    expect(started.status).toBe(200)
    const session = started.data.result
    expect(session).toMatchObject({
      conversation: target,
      mode: 'combined',
      state: 'running',
      title: 'alpha, beta',
      url: 'http://127.0.0.1:19432',
    })
    expect(session.repos.map((item: { base?: string }) => item.base)).toEqual(['main', 'main'])

    const call = JSON.parse(await readFile(join(dir, 'call.json'), 'utf8'))
    expect(call.args).toEqual(expect.arrayContaining(['review', '--json', '--patch-file']))
    expect(call.env).toMatchObject({
      BROWSER: 'none',
      PLANNOTATOR_SHARE: 'disabled',
      PLANNOTATOR_AI: 'disabled',
      PLANNOTATOR_GIT_REMOTE_CHECK: '0',
      PLANNOTATOR_PORT: '19432',
    })
    // Committed and untracked work of both, each under its own name.
    for (const line of [
      '+++ b/alpha/f.txt',
      '+alpha change',
      '+++ b/alpha/new.txt',
      '+++ b/beta/f.txt',
      '+beta change',
    ])
      expect(call.patch).toContain(line)

    server.host.faux!.setResponses([fauxAssistantMessage('On it.')])
    const feedback = '# Code Review Feedback\n\n## alpha/f.txt\n\nWhy this change?'
    await writeFile(
      join(dir, 'decision.json'),
      JSON.stringify({ decision: 'annotated', message: feedback }),
    )
    const conversation = (await server.harness.conversation(target as ConversationId, context))!
    await until(async () =>
      (await conversation.context(context)).entries.some(
        (entry) => entry.kind === 'plannotator.result',
      ),
    )
    await server.harness.waitForIdle(context)
    const entries = (await conversation.context(context)).entries
    const result = entries.find((entry) => entry.kind === 'plannotator.result')!
    expect(result.data).toMatchObject({ decision: 'annotated', message: feedback })
    const message = result.model?.[0]
    expect(message && 'content' in message ? message.content : undefined).toContain(
      'Why this change?',
    )
    // It woke the conversation as the user's typed message would.
    expect(entries.at(-1)?.kind).toBe('pi.assistant')
    const overview = (await action('overview', null)).data.result
    expect(overview.sessions[0]).toMatchObject({ id: session.id, state: 'annotated' })
  } finally {
    await server.close()
  }
})
