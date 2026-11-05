import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Exec, Protocol } from './api.ts'
import { createExec, localProtocol } from './exec.ts'
import { TargetAction } from './refs.ts'

export const actions = {
  /** `{ cwd }`: the target that runs commands in `cwd`, as its protocol describes it. */
  target: implementAction(TargetAction, (args, { host }) => {
    const cwd = args && typeof args === 'object' && !Array.isArray(args) ? args.cwd : undefined
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('Expected { cwd: "/…" }')
    return host.need(Exec).describe(cwd)
  }),
}

export default function exec(host: ExtensionHost) {
  // The protocol point is wanted at setup so the catalogue records it; read again at every call, so a provider that
  // loads later or reloads is used from then on.
  host.want(Protocol)
  const service = createExec(localProtocol, () => host.want(Protocol))
  host.implement(Exec, service)
  host.executionEnv((cwd) => service.env(cwd))
  return { name: 'exec' }
}
