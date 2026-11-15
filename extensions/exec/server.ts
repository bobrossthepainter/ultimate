import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Exec, Protocol } from './api.ts'
import { createExec, localProtocol } from './exec.ts'
import { TargetAction } from './refs.ts'

export const actions = {
  target: implementAction(TargetAction, (args, { host }) => {
    const cwd = args && typeof args === 'object' && !Array.isArray(args) ? args.cwd : undefined
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('Expected { cwd: "/…" }')
    return host.need(Exec).describe(cwd)
  }),
}

export default function exec(host: ExtensionHost) {
  host.want(Protocol)
  const service = createExec(localProtocol, () => host.want(Protocol))
  host.implement(Exec, service)
  host.execution({ env: service.env, run: service.run })
  return { name: 'exec' }
}
