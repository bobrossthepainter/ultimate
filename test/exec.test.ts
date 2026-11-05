import { realpath } from 'node:fs/promises'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { expect, it } from 'vitest'
import type { ExtensionHost } from '../server/extensions.ts'
import exec, { actions } from '../extensions/exec/server.ts'
import type { ActionContext } from '../server/actions.ts'
import { Exec, Protocol } from '../extensions/exec/api.ts'
import type { ExecTarget, ExecTargets } from '../extensions/exec/api.ts'
import type { Group } from '../lib/process-group.ts'
import { exec as hostExec } from '../lib/exec.ts'
import { apis, temp } from './helpers.ts'

const target = (id: string, root: string): ExecTarget => ({
  protocol: 'fake',
  id,
  root,
  files: 'shared',
  config: null,
})

/** The exec extension on a hand-built host, with the environment builder it hands the harness. */
function load(protocol?: ExecTargets) {
  const host = apis()
  if (protocol) host.implement(Protocol, protocol)
  let build: ((cwd: string) => ExecutionEnv) | undefined
  exec({
    ...host,
    executionEnv: (next: (cwd: string) => ExecutionEnv) => {
      build = next
    },
  } as unknown as ExtensionHost)
  return { service: host.provided.get(Exec.name) as typeof Exec.service & object, build: build! }
}

it('routes a directory to the target with the longest root containing it, else runs it locally', () => {
  const targets = [
    target('outer', '/work'),
    target('inner', '/work/app'),
    target('root', '/work/a'),
  ]
  const { service } = load({ targets: () => targets } as unknown as ExecTargets)
  expect(service.resolve('/work/app/src').id).toBe('inner')
  expect(service.resolve('/work/app').id).toBe('inner')
  expect(service.resolve('/work/apple').id).toBe('outer')
  expect(service.resolve('/work').id).toBe('outer')
  expect(service.resolve('/elsewhere').protocol).toBe('local')
  expect(load().service.resolve('/work/app').protocol).toBe('local')
})

it('hands run, start, git and env under a registered root to its protocol; the rest and host-local callers run here', async () => {
  const local = await realpath(await temp('ultimate-exec-'))
  const calls: unknown[][] = []
  const group = {} as Group
  const env = {} as ExecutionEnv
  const { service, build } = load({
    targets: () => [target('box', '/box')],
    run: async (to, cwd, file, args) => {
      calls.push(['run', to.id, cwd, file, args])
      return { stdout: ' remote \n', stderr: '' }
    },
    start: (to, cwd, file, args) => {
      calls.push(['start', to.id, cwd, file, args])
      return group
    },
    env: (to, cwd) => {
      calls.push(['env', to.id, cwd])
      return env
    },
    describe: () => 'box',
  })
  expect(await service.run('/box/app', 'make', ['test'])).toEqual({
    stdout: ' remote \n',
    stderr: '',
  })
  expect(service.start('/box/app', 'pnpm', ['dev'])).toBe(group)
  expect(await service.git('/box/app', 'status')).toBe('remote')
  expect(build('/box/app')).toBe(env)
  expect(calls).toEqual([
    ['run', 'box', '/box/app', 'make', ['test']],
    ['start', 'box', '/box/app', 'pnpm', ['dev']],
    ['run', 'box', '/box/app', 'git', ['status']],
    ['env', 'box', '/box/app'],
  ])
  calls.length = 0
  expect((await service.run(local, 'pwd', [])).stdout.trim()).toBe(local)
  expect(build(local).cwd).toBe(local)
  // lib/exec.ts stays host-local: a cwd the protocol owns does not reach it.
  await expect(hostExec('pwd', [], { cwd: '/box/app' })).rejects.toThrow('ENOENT')
  expect(calls).toEqual([])
})

it('describes where a directory runs through its protocol, and the target action answers the UI with it', () => {
  const { service } = load({
    targets: () => [target('box', '/box')],
    describe: (to: ExecTarget) => `fake ${to.id}`,
  } as unknown as ExecTargets)
  expect(service.describe('/box/app')).toEqual({
    protocol: 'fake',
    id: 'box',
    root: '/box',
    description: 'fake box',
  })
  expect(service.describe('/elsewhere')).toEqual({
    protocol: 'local',
    id: 'local',
    root: '/',
    description: 'local Node',
  })
  const host = { need: () => service } as unknown as ActionContext['host']
  expect(actions.target({ cwd: '/box' }, { host } as ActionContext)).toMatchObject({
    id: 'box',
  })
  expect(() => actions.target({ cwd: 'box' }, { host } as ActionContext)).toThrow('Expected')
})
