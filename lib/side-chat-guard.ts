import type { ConversationId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../server/extensions.ts'

export function tracksEffect(name: string, args: Record<string, unknown>) {
  if (name === 'todo') return args.action === 'add' || args.action === 'done'
  if (name === 'automation') return !['list', 'runs', 'log'].includes(String(args.action))
  return [
    'branch',
    'message',
    'note',
    'notify',
    'remember',
    'setup',
    'restart',
    'edit',
    'write',
  ].includes(name)
}

export function blockedInReadOnlySideChat(name: string, args: Record<string, unknown>) {
  if (tracksEffect(name, args)) return true
  if (['subagent', 'goal', 'ultimate.action', 'ultimate.tell'].includes(name)) return true
  if (name === 'plan') return args.action !== 'show'
  if (name === 'workspace') return args.action !== 'status'
  if (name === 'instance') return !['list', 'logs'].includes(String(args.action))
  return false
}

export const readOnlyRefusal = (name: string) =>
  `A side chat of a branch is read-only: ${name} is refused. Answer the user here instead.`

export async function guardSideChatCall(
  host: Pick<ExtensionHost, 'doc' | 'harness'>,
  id: ConversationId,
  name: string,
  args: Record<string, unknown>,
  context: Context,
) {
  const sidechatByKind = host.doc('sidechat')
  if (!sidechatByKind) return
  await host.harness().commit(async (tx) => {
    const side = await tx.doc(sidechatByKind, id)
    if (typeof side.of !== 'number') return
    if (side.readOnly && blockedInReadOnlySideChat(name, args))
      throw new Error(readOnlyRefusal(name))
    if (tracksEffect(name, args)) side.effects = true
  }, context)
}
