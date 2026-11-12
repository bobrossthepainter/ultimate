import type { JsonValue } from '@earendil-works/chord/json'
import type { Execution } from './harness.ts'
import type { Device } from '../shared/events.ts'
import type { ExtensionHost } from './extensions.ts'

export interface ActionContext {
  host: ExtensionHost
  conversationId?: number
  /** The browser that asked, for a call from the UI; agents' calls have none. */
  device?: Device
  signal: AbortSignal
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string }>
}
export type ExtensionAction = (
  args: JsonValue,
  ctx: ActionContext,
) => JsonValue | Promise<JsonValue>
/** `exec` for an action: `command` in `cwd` where that directory lives (the exec service routes it), never a shell. */
export function actionExec(
  run: Execution['run'],
  cwd: string,
  signal: AbortSignal,
): ActionContext['exec'] {
  return (command, args, options = {}) =>
    run(cwd, command, args, {
      signal,
      timeout: Math.max(1, Math.min(options.timeout ?? 30000, 30000)),
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    })
}
