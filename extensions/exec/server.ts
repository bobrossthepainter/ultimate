import type { ExtensionHost } from '../../server/extensions.ts'
import { Exec, Protocol } from './api.ts'
import { createExec, localProtocol } from './exec.ts'

export default function exec(host: ExtensionHost) {
  // The protocol point is wanted at setup so the catalogue records it; read again at every call, so a provider that
  // loads later or reloads is used from then on.
  host.want(Protocol)
  const service = createExec(localProtocol, () => host.want(Protocol))
  host.implement(Exec, service)
  host.executionEnv((cwd) => service.env(cwd))
  return { name: 'exec' }
}
