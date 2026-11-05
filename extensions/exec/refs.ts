/** Exec in the browser: where a directory's commands run. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** The target owning a directory, as its protocol describes it; never its secrets. */
export type TargetInfo = {
  /** `local`, or the protocol's name (`ssh`). */
  protocol: string
  id: string
  root: string
  /** The protocol's one-line description of the target: `local Node`, `user@host:port`. */
  description: string
}

/** `{ cwd }` → the target that runs commands in `cwd`. */
export const TargetAction = actionRef<{ cwd: string }, TargetInfo>('exec', 'target')
