/**
 * Lifecycle: tells a process manager (a Kubernetes operator scaling an instance to zero) whether anything runs and when
 * the instance must run again. Off by default.
 */
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { AutomationsApi } from '../automations/api.ts'
import { StateAction } from './refs.ts'
import type { LifecycleState } from './refs.ts'

export async function state(host: ExtensionHost, now = Date.now()): Promise<LifecycleState> {
  const wake = host.harness().wake()
  const automations = host.want(AutomationsApi)
  const [input] = await host.eventLog.recent({ events: [UserInputEvent], limit: 1 })
  const wakes = [
    ...(wake.at === undefined ? [] : [{ at: wake.at, reason: 'sleeping task' }]),
    ...((await automations?.wakes(now)) ?? []),
  ].toSorted((a, b) => a.at - b.at)
  return {
    now,
    active: wake.active,
    busy: host
      .conversations()
      .filter((conversation) => conversation.busy)
      .map((conversation) => conversation.id),
    scripts: (await automations?.scripts()) ?? [],
    ...(input ? { inputAt: Date.parse(input.at) } : {}),
    ...(wakes.length ? { nextWake: wakes[0].at } : {}),
    wakes,
  }
}

export default function lifecycle(host: ExtensionHost) {
  // Resolved where it is called; declared here so the catalogue lists it.
  host.want(AutomationsApi)
  return defineExtension({ name: 'lifecycle' })
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
}
