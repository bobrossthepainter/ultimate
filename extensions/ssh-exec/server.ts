import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Protocol } from '../exec/api.ts'
import type { ExecTarget } from '../exec/api.ts'
import { SshExecApi } from './api.ts'
import type { TargetStatus } from './api.ts'
import { address, probe, release, sshProtocol, targetsOf } from './ssh.ts'
import type { Target } from './ssh.ts'

export const reloadOnSettings = true

export default async function sshExec(host: ExtensionHost) {
  // Only the machine's own settings name targets: a project must not send this machine's commands anywhere.
  const targets = targetsOf((await readSettings(userSettingsPath(host.userHome)))['ssh-exec'])
  // Control sockets need a short path (sun_path holds about 100 bytes) and belong to this process alone.
  const sockets = mkdtempSync(join(tmpdir(), 'ultimate-ssh-'))
  const statuses = new Map<string, TargetStatus>(
    targets.map((target) => [
      target.id,
      { id: target.id, root: target.root, address: address(target), state: 'unchecked' },
    ]),
  )
  const checking = new Map<string, Promise<string | undefined>>()
  /** Connect to `target` once at a time; its status says whether it worked. */
  const check = (target: Target) => {
    const running = checking.get(target.id)
    if (running) return running
    const next = probe(target, sockets).then((error) => {
      statuses.set(target.id, {
        ...statuses.get(target.id)!,
        state: error ? 'unreachable' : 'ready',
        ...(error ? { error } : {}),
      })
      checking.delete(target.id)
      return error
    })
    checking.set(target.id, next)
    return next
  }
  const ready = (target: Target) => {
    const { error: _, ...status } = statuses.get(target.id)!
    statuses.set(target.id, { ...status, state: 'ready' })
  }
  const protocol = sshProtocol(sockets, (target, code) => {
    // 255 is ssh failing (or a command that exits 255): connect again to tell which.
    if (code === 255)
      void check(target).catch(
        // probe resolves its failures; nothing else can reject.
        () => undefined,
      )
    else if (code !== null) ready(target)
  })
  const routed: ExecTarget[] = targets.map((target) => ({
    protocol: 'ssh',
    id: target.id,
    root: target.root,
    files: 'shared',
    config: target,
  }))
  host.implement(Protocol, {
    ...protocol,
    targets: () => routed,
    run: async (target, ...rest) => {
      try {
        return await protocol.run(target, ...rest)
      } catch (error) {
        if ((error as { code?: unknown }).code !== 255) throw error
        const config = target.config as Target
        const reason = await check(config)
        if (!reason) throw error
        throw Object.assign(
          new Error(`ssh-exec target ${config.id} (${address(config)}) is unreachable: ${reason}`, {
            cause: error,
          }),
          {
            code: 255,
            stdout: (error as { stdout?: string }).stdout,
            stderr: (error as { stderr?: string }).stderr,
          },
        )
      }
    },
  })
  host.implement(SshExecApi, { status: () => [...statuses.values()] })
  for (const target of targets)
    void check(target).catch(
      // probe resolves its failures; nothing else can reject.
      () => undefined,
    )
  host.onClose(async () => {
    // Commands still running keep their connection until they end; new ones open their own under the next sockets.
    await Promise.all(
      targets.map((target) =>
        release(target, sockets).catch(
          // No connection was ever opened, or it is already gone.
          () => undefined,
        ),
      ),
    )
    await rm(sockets, { recursive: true, force: true })
  })
  return { name: 'ssh-exec' }
}
