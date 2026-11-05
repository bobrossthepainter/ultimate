/** Lifecycle: whether this instance may stop now, and when it must run again. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Times are ms since the epoch on this machine's clock; `now` lets a caller correct for skew. */
export type LifecycleState = {
  now: number
  /** Some task runs or can run now, background ones included. */
  active: boolean
  /** Conversations with non-background work, as the sidebar shows them busy; a landing included. */
  busy: number[]
  /** Automations whose script process is alive. */
  scripts: string[]
  /** The user's latest input, in any conversation. */
  inputAt?: number
  /** The earliest of `wakes`. */
  nextWake?: number
  /** When something next needs the process: Pi's sleeping tasks, and automations' schedules and pauses. */
  wakes: { at: number; reason: string }[]
}

/** No arguments → the instance's lifecycle state. */
export const StateAction = actionRef<null, LifecycleState>('lifecycle', 'state')
