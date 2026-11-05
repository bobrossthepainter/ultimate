/**
 * SSH exec: runs the commands of configured directory roots on SSH targets, as the `ssh` protocol of `exec.protocol`.
 * Other extensions read whether each target is reachable.
 */
import { defineApi } from '../../shared/extension-api.ts'

/** One target's last known state: `unchecked` until its first connection, `unreachable` with ssh's reason. */
export type TargetStatus = {
  id: string
  root: string
  /** `user@host:port`. */
  address: string
  state: 'unchecked' | 'ready' | 'unreachable'
  error?: string
}

export interface SshExecService {
  /** Every configured target with what its latest connection or command showed; read it to report a failing one. */
  status(): TargetStatus[]
}
/** SSH exec targets; `want` it, since ssh-exec is optional. */
export const SshExecApi = defineApi<SshExecService>()('ssh-exec')
