import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExecService } from '../exec/api.ts'

export async function setup(
  exec: ExecService,
  source: string,
  path: string,
  settings: JsonObject,
  signal: AbortSignal,
) {
  const commands =
    (settings as { isolates?: { worktree?: { setup?: string[] } } }).isolates?.worktree?.setup ?? []
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === 'string'))
    throw new Error('isolates.worktree.setup must be an array of command strings')
  for (const command of commands) {
    signal.throwIfAborted()
    try {
      await exec.run(path, 'sh', ['-c', command], {
        env: { ...process.env, ULTIMATE_SOURCE: source },
        signal,
        timeout: 120000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string }
      throw new Error(
        `Worktree setup failed: ${command}\n${`${output.stdout ?? ''}${output.stderr ?? ''}${output.message}`.slice(-4000)}`,
        { cause: error },
      )
    }
  }
}
