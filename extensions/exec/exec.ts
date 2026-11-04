import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { gitWith } from '../../lib/git.ts'
import { spawnGroup } from '../../lib/process-group.ts'
import { execFile, spawn } from '../../lib/spawn.ts'
import type { ExecProtocol, ExecService, ExecTarget, ExecTargets } from './api.ts'

/** This machine: what every directory no protocol claims runs on. */
export const localTarget: ExecTarget = {
  protocol: 'local',
  id: 'local',
  root: '/',
  files: 'shared',
  config: null,
}

/** Whether `cwd` is `root` or below it. */
const under = (cwd: string, root: string) =>
  cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)

/** The built-in protocol: execFile and spawnGroup through the process helper, and Pi's Node environment. */
export const localProtocol: ExecProtocol = {
  run: (_target, cwd, file, args, options) => execFile(file, args, { ...options, cwd }),
  start: (_target, cwd, file, args, options = {}) => spawnGroup(file, args, { ...options, cwd }),
  // Agents' commands start from the process helper (the patched spawn option), never by forking this process.
  env: (_target, cwd): ExecutionEnv => new NodeExecutionEnv({ cwd, spawn }),
}

/** The exec service over `local` and whatever protocol `routed` returns now (none while no extension provides one). */
export function createExec(
  local: ExecProtocol,
  routed: () => ExecTargets | undefined,
): ExecService {
  const resolve = (cwd: string) =>
    (routed()?.targets() ?? [])
      .filter((target) => under(cwd, target.root))
      .reduce<ExecTarget | undefined>(
        (best, target) => (best && best.root.length >= target.root.length ? best : target),
        undefined,
      ) ?? localTarget
  const route = (cwd: string): [ExecProtocol, ExecTarget] => {
    const target = resolve(cwd)
    return [target === localTarget ? local : routed()!, target]
  }
  const run: ExecService['run'] = (cwd, file, args, options) => {
    const [protocol, target] = route(cwd)
    return protocol.run(target, cwd, file, args, options)
  }
  return {
    resolve,
    run,
    start(cwd, file, args, options) {
      const [protocol, target] = route(cwd)
      return protocol.start(target, cwd, file, args, options)
    },
    git: gitWith((file, args, { cwd, ...options }) => run(cwd, file, args, options)),
    env(cwd) {
      const [protocol, target] = route(cwd)
      return protocol.env(target, cwd)
    },
  }
}
