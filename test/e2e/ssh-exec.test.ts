import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { stopGroup } from '../../lib/process-group.ts'
import { createExec, localProtocol } from '../../extensions/exec/exec.ts'
import type { ExecTargets } from '../../extensions/exec/api.ts'
import { sshProtocol } from '../../extensions/ssh-exec/ssh.ts'
import type { Target } from '../../extensions/ssh-exec/ssh.ts'
import { temp, until } from '../helpers.ts'

const sshd = '/usr/sbin/sshd'

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

const keygen = (path: string) =>
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path])

/** Whether a process named `marker` (`exec -a`) still runs on this machine, the sshd's target. */
const running = (marker: string) => {
  try {
    // Anchored: the remote wrapper's own command line contains the marker too.
    execFileSync('pgrep', ['-f', `^${marker} `])
    return true
  } catch {
    // pgrep exits 1 when nothing matches.
    return false
  }
}

// An sshd of the current user on a loopback port stands in for the toolchain container.
describe.skipIf(!existsSync(sshd))('ssh-exec against a local sshd', () => {
  let dir: string
  let daemon: ChildProcess
  let target: Target
  let sockets: string
  let exec: ReturnType<typeof createExec>
  const exits: (number | null)[] = []

  beforeAll(async () => {
    dir = await temp('ultimate-ssh-exec-')
    // Short, as the extension keeps them: the lander's TMPDIR is too deep for a control socket (#7522).
    sockets = await mkdtemp('/tmp/ultimate-ssh-test-')
    await mkdir(join(dir, 'root'))
    keygen(join(dir, 'host'))
    keygen(join(dir, 'client'))
    await writeFile(join(dir, 'authorized'), await readFile(join(dir, 'client.pub')))
    const port = await freePort()
    const config = join(dir, 'sshd_config')
    await writeFile(
      config,
      [
        `ListenAddress 127.0.0.1:${port}`,
        `HostKey ${join(dir, 'host')}`,
        `AuthorizedKeysFile ${join(dir, 'authorized')}`,
        'PidFile none',
        'UsePAM no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        // The temp directory's modes are not sshd's business here.
        'StrictModes no',
        '',
      ].join('\n'),
    )
    const hostKey = (await readFile(join(dir, 'host.pub'), 'utf8')).split(' ').slice(0, 2).join(' ')
    await writeFile(join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${hostKey}\n`)
    daemon = spawn(sshd, ['-D', '-e', '-f', config], { stdio: 'ignore' })
    target = {
      id: 'toolchain',
      root: join(dir, 'root'),
      files: 'shared',
      host: '127.0.0.1',
      port,
      user: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(),
      identityFile: join(dir, 'client'),
      knownHostsFile: join(dir, 'known_hosts'),
    }
    const protocol = sshProtocol(sockets, (_target, code) => exits.push(code))
    const routed: ExecTargets = {
      ...protocol,
      targets: () => [
        { protocol: 'ssh', id: target.id, root: target.root, files: 'shared', config: target },
      ],
    }
    exec = createExec(localProtocol, () => routed)
    // sshd listens a moment after it starts; then the first run must work, or fail with ssh's reason.
    await until(() => listening(port))
    await exec.run(target.root, 'true', [])
  })

  afterAll(async () => {
    daemon?.kill()
    if (target)
      try {
        execFileSync('ssh', ['-o', `ControlPath=${join(sockets, target.id)}`, '-O', 'exit', 'x'], {
          stdio: 'ignore',
        })
      } catch {
        // No shared connection left.
      }
    await rm(sockets, { recursive: true, force: true })
  })

  it('runs a cwd under the root over SSH and one outside it here, with cwd, arguments and variables intact', async () => {
    const under = join(target.root, "it's here")
    await mkdir(under)
    const script = 'printf "%s|" "$PWD" "${SSH_CONNECTION:+ssh}" "$EXTRA" "$@"'
    const args = ['a b', "c'd", '$(id)', '*', '']
    const env = { ...process.env, EXTRA: 'x "y" $z' }
    const remote = await exec.run(under, 'sh', ['-c', script, 'sh', ...args], { env })
    expect(remote.stdout).toBe(`${under}|ssh|x "y" $z|a b|c'd|$(id)|*||`)
    const local = await exec.run(dir, 'sh', ['-c', script, 'sh', 'x'], { env })
    expect(local.stdout).toBe(`${dir}||x "y" $z|x|`)
  })

  it('reports exit codes and output like execFile', async () => {
    const failure = (await exec
      .run(target.root, 'sh', ['-c', 'echo out; echo err >&2; exit 7'])
      .catch((error: unknown) => error)) as { code: number; stdout: string; stderr: string }
    expect(failure).toMatchObject({ code: 7, stdout: 'out\n', stderr: 'err\n' })
  })

  it('kills the remote process group when a run is aborted or times out', async () => {
    const abort = new AbortController()
    const marker = `ssh-exec-abort-${process.pid}`
    const run = exec
      .run(
        target.root,
        'bash',
        ['-c', `(exec -a ${marker}-child sleep 300) & exec -a ${marker} sleep 301`],
        {
          signal: abort.signal,
        },
      )
      .catch((error: unknown) => error)
    await until(() => running(marker))
    abort.abort()
    expect(await run).toMatchObject({ name: 'AbortError' })
    // The background child is in the same remote group, so it goes too.
    await until(() => !running(marker) && !running(`${marker}-child`))

    const timed = `ssh-exec-timeout-${process.pid}`
    const failure = await exec
      .run(target.root, 'bash', ['-c', `exec -a ${timed} sleep 302`], { timeout: 500 })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ killed: true })
    await until(() => !running(timed))
  })

  it('streams a started group and stops it, with a child that ignores TERM, before the stop returns', async () => {
    const marker = `ssh-exec-start-${process.pid}`
    const group = exec.start(target.root, 'bash', [
      '-c',
      `echo started; (trap '' TERM; exec -a ${marker} sleep 303) & wait`,
    ])
    let output = ''
    group.child.stdout.setEncoding('utf8').on('data', (text: string) => (output += text))
    await until(() => output === 'started\n' && running(marker))
    await stopGroup(group.child.pid!, { leader: group })
    // The lander removes its checkout once the stop returns: nothing of the remote group may still run then.
    expect(running(marker)).toBe(false)
    expect(await group.ended).toBe(true)
  })

  it("passes git's numbered config whole when the caller extends this process's", async () => {
    // The agent's bash appends its commit hooks after the ones this process inherited (#7522).
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'ssh-exec.inherited')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'a')
    try {
      const { stdout } = await exec.run(
        target.root,
        'git',
        ['config', '--get-regexp', '^ssh-exec'],
        {
          env: {
            ...process.env,
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_1: 'ssh-exec.added',
            GIT_CONFIG_VALUE_1: 'b',
          },
        },
      )
      expect(stdout).toBe('ssh-exec.inherited a\nssh-exec.added b\n')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('sets variables for the command only, even a PATH without the tools the target needs', async () => {
    const { stdout } = await exec.run(target.root, '/usr/bin/printenv', ['PATH'], {
      env: { ...process.env, PATH: '/nonexistent' },
    })
    expect(stdout).toBe('/nonexistent\n')
  })

  it("runs the agent's shell over SSH and kills its children on abort", async () => {
    const env = exec.env(target.root)
    let output = ''
    const done = await env.exec(
      'echo "${SSH_CONNECTION:+ssh}:$PWD"',
      { onOutput: (text) => (output += text) },
      BACKGROUND_CONTEXT,
    )
    expect(done).toMatchObject({ ok: true, value: { exitCode: 0 } })
    expect(output).toBe(`ssh:${target.root}\n`)

    const marker = `ssh-exec-env-${process.pid}`
    const abort = new AbortController()
    const call = env.exec(
      `(exec -a ${marker} sleep 304) & wait`,
      undefined,
      withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
    )
    await until(() => running(marker))
    abort.abort()
    expect(await call).toMatchObject({ ok: false, error: { code: 'aborted' } })
    await until(() => !running(marker))
  })

  it('refuses a host whose key is unknown or changed', async () => {
    const empty = join(dir, 'empty_known_hosts')
    await writeFile(empty, '')
    const other = join(dir, 'other')
    keygen(other)
    const changed = join(dir, 'changed_known_hosts')
    const otherKey = (await readFile(`${other}.pub`, 'utf8')).split(' ').slice(0, 2).join(' ')
    await writeFile(changed, `[127.0.0.1]:${target.port} ${otherKey}\n`)
    for (const knownHostsFile of [empty, changed]) {
      // Another id, so it opens its own connection instead of reusing the pinned one.
      const config = { ...target, id: `pinned-${knownHostsFile.length}`, knownHostsFile }
      const failure = (await sshProtocol(sockets, () => {})
        .run(
          { protocol: 'ssh', id: config.id, root: config.root, files: 'shared', config },
          target.root,
          'true',
          [],
        )
        .catch((error: unknown) => error)) as { code: number; stderr: string }
      expect(failure.code).toBe(255)
      expect(failure.stderr).toContain('Host key verification failed')
    }
    // Nothing was learned on first use.
    expect(await readFile(empty, 'utf8')).toBe('')
  })
})
