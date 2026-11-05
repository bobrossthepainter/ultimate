import { mkdir, writeFile } from 'node:fs/promises'
import type { JsonValue } from '@earendil-works/chord'
import { join, resolve } from 'node:path'
import { defineExtension, defineTask } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Automations } from '../extensions/automations/server.ts'
import type { Automation } from '../extensions/automations/types.ts'
import type { LifecycleState } from '../extensions/lifecycle/refs.ts'
import { emit } from '../server/events.ts'
import { context } from '../server/harness.ts'
import { UserInputEvent } from '../shared/events.ts'
import { fauxServer, post, removeTemps, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await removeTemps()
})

/** A background task that runs until the test releases it, as a dream pass does. */
const held = (released: Promise<void>) =>
  defineTask<null, { phase: 'run' }, null>({
    name: 'lifecycle-test.held',
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (_task, runtime, ctx) => {
        await released
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

async function launch() {
  const home = await temp('ultimate-lifecycle-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['lifecycle', 'subagents'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const state = async () =>
    (
      (await post(server, '/api/extensions/lifecycle/actions/state', { args: {} })).data as {
        result: LifecycleState
      }
    ).result
  const create = (args: JsonValue) =>
    server.extensions.invoke(
      'automations',
      'create',
      args,
      new AbortController().signal,
      server.root.id,
    ) as Promise<Automation>
  return { server, state, create }
}

it('reports schedules, and idle conditions only once over their threshold, at the end of the pause', async () => {
  const { server, state, create } = await launch()
  const HOUR = 3600_000
  const schedule = await create({ name: 'Hourly', schedule: 'every 1h', subscribers: [1] })
  const idle = await create({
    name: 'Pause',
    condition: { metric: 'context', of: `#${server.root.id}`, above: 50, idleFor: 8 * HOUR },
    subscribers: [1],
  })
  await until(async () => (await state()).wakes.some((wake) => wake.reason.startsWith(schedule.id)))
  const measured = (value: number, inputAt: number) =>
    server.harness.commit(async (tx) => {
      Object.assign((await tx.doc(Automations)).automations[idle.id].condition!, {
        value,
        inputAt,
      })
    }, context)
  const inputAt = Date.now() - HOUR
  await measured(40, inputAt)
  const below = await state()
  const nextAt = (await server.harness.snapshot(Automations, context))!.automations[schedule.id]
    .nextAt!
  // The scheduler's own sleep is Pi's too.
  expect(below.wakes).toContainEqual({ at: nextAt, reason: 'sleeping task' })
  expect(below.wakes).toContainEqual({ at: nextAt, reason: `${schedule.id} Every 1 hour` })
  expect(below.wakes.some((wake) => wake.reason.startsWith(idle.id))).toBe(false)
  await measured(60, inputAt)
  const above = await state()
  expect(above.wakes).toContainEqual({
    at: inputAt + 8 * HOUR,
    reason: `${idle.id} when #${server.root.id} context ≥ 50% after 8h without the user's input`,
  })
  expect(above.nextWake).toBe(Math.min(...above.wakes.map((wake) => wake.at)))
})

it('is active for a background task while no conversation is busy, and reports the latest input', async () => {
  const { server, state } = await launch()
  const released = Promise.withResolvers<void>()
  const task = held(released.promise)
  server.host.registry.install(defineExtension({ name: 'lifecycle-test', tasks: [task] }))
  await server.harness.commit(async (tx) => {
    await tx.createTask(task, null, {
      conversationId: server.root.id,
      ownership: { kind: 'conversation' },
      background: true,
    })
    await emit(tx, UserInputEvent, {
      conversation: server.root.id,
      kind: 'prompt',
      length: 1,
    })
  }, context)
  const running = await state()
  expect(running).toMatchObject({ active: true, busy: [], scripts: [] })
  expect(running.inputAt).toBeGreaterThan(Date.now() - 60_000)
  released.resolve()
  await until(async () => !(await state()).active)
})
