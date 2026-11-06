import { mkdtempSync, rmSync } from 'node:fs'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Protocol } from '../exec/api.ts'
import type { ExecTarget } from '../exec/api.ts'
import { SshExecApi } from './api.ts'
import type { TargetStatus } from './api.ts'
import { address, probe, release, sshProtocol, targetsOf } from './ssh.ts'
import type { Target } from './ssh.ts'

export const reloadOnSettings = true

const socketsKey = Symbol.for('ultimate.ssh-exec.sockets')

/**
 * The control socket directory of this process, kept across facet reloads and removed at exit. The harness keeps the
 * envs it built across reloads (a settings change), so a directory per facet load, deleted on close, left them failing
 * with "cannot create control socket" (ultimate-k8s #1662). A reload evaluates this module again, hence `globalThis`.
 * It needs a short path: ssh refuses one of 108 bytes or more, which a deep TMPDIR (the lander's checks set one under
 * the project home) reaches. So /tmp, never tmpdir() (#7522).
 */
function socketsDir() {
  const state = globalThis as unknown as Record<symbol, string | undefined>
  if (!state[socketsKey]) {
    const dir = mkdtempSync('/tmp/ultimate-ssh-')
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    state[socketsKey] = dir
  }
  return state[socketsKey]
}

export default async function sshExec(host: ExtensionHost) {
  // Only the machine's own settings name targets: a project must not send this machine's commands anywhere.
  const targets = targetsOf((await readSettings(userSettingsPath(host.userHome)))['ssh-exec'])
  const sockets = socketsDir()
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
    // Commands still running keep their connection until they end; new ones open a fresh one at the same path.
    await Promise.all(
      targets.map((target) =>
        release(target, sockets).catch(
          // No connection was ever opened, or it is already gone.
          () => undefined,
        ),
      ),
    )
  })
  return { name: 'ssh-exec' }
}
