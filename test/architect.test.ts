import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { Index, Versions } from '../extensions/architect/server.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from './helpers.ts'

const diagram = {
  id: 'components',
  title: 'Components',
  mermaid: 'flowchart LR\n  surface[Surface]:::added --> doc[(Versions)]',
  notes: ['The surface reads the doc.'],
  parts: { surface: 'the Architecture tab', doc: 'architect.versions' },
}

it('draws versions in one architect under the branch, and sends feedback to the coordinator', async () => {
  const home = await temp('ultimate-architect-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['architect'] }, summaryModel: 'unavailable/test' }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    const briefs: string[] = []
    // The architect publishes on each brief; every other input gets a plain answer.
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.at(-1)
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content.startsWith('Draw version')
      ) {
        briefs.push(last.content)
        return fauxAssistantMessage(
          [
            fauxToolCall('architecture_publish', {
              title: 'Architect',
              summary: 'Adds the surface.',
              diagrams: [diagram],
            }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      return fauxAssistantMessage('Adds the surface.')
    }
    server.host.faux!.setResponses([route])
    const branch = (await post(server, '/api/conversations', { title: 'Feature' })).data
      .id as number
    const busy = async (id: number) =>
      (await server.harness.snapshot(LiveDoc, id as ConversationId, context))?.run !== undefined
    const draw = async () => {
      // Counted before posting: the architect may take its brief before the response returns.
      const before = briefs.length
      const response = await post(server, '/api/extensions/architect/actions/draw', {
        args: { conversation: branch },
      })
      expect(response.status).toBe(200)
      await until(
        async () => briefs.length > before && !(await busy(response.data.result.architect)),
      )
      return response.data.result as { architect: number; started: boolean }
    }

    const first = await draw()
    expect(first.started).toBe(true)
    const second = await draw()
    // One architect per branch, owned under it, configured from its definition.
    expect(second.architect).toBe(first.architect)
    const record = await server.harness.commit(
      (tx) => tx.conversation(first.architect as ConversationId),
      context,
    )
    expect(record?.owner?.conversationId).toBe(branch)
    const versions = (await server.harness.snapshot(Versions, branch as ConversationId, context))!
    expect(versions.versions.map((version) => version.version)).toEqual([1, 2])
    expect(versions.versions[1]).toMatchObject({ architect: first.architect, diagrams: [diagram] })
    expect(
      (await server.harness.snapshot(Index, ROOT_CONVERSATION_ID, context))!.branches[
        String(branch)
      ],
    ).toMatchObject({ version: 2 })
    // The second brief carries the first version's source, so its IDs stay stable.
    expect(briefs[0]).toContain('None: this is the first.')
    expect(briefs[1]).toContain('Previous version (v1)')
    expect(briefs[1]).toContain('surface[Surface]:::added')
    // Drawing from the architect's own conversation draws its branch.
    expect(
      (
        await post(server, '/api/extensions/architect/actions/draw', {
          args: { conversation: first.architect },
        })
      ).data.result.architect,
    ).toBe(first.architect)
    await server.harness.waitForIdle(context)

    const sent = await post(server, '/api/extensions/architect/actions/send', {
      args: {
        conversation: branch,
        branch,
        version: 2,
        note: 'Mostly naming.',
        comments: [
          {
            diagram: 'components',
            kind: 'node',
            part: 'surface',
            label: 'Surface',
            text: 'Why a tab?',
          },
        ],
      },
    })
    expect(sent.status).toBe(200)
    await server.harness.waitForIdle(context)
    const conversation = (await server.harness.conversation(branch as ConversationId, context))!
    const entries = (await conversation.context(context)).entries
    const feedback = entries.filter((entry) => entry.kind === 'architect.comments')
    expect(feedback).toHaveLength(1)
    const message = feedback[0].model?.[0]
    expect(message && 'content' in message ? message.content : undefined).toBe(
      [
        'Architecture feedback on v2 of #' + branch + "'s diagrams (1 comment)",
        'Mostly naming.',
        '**Components** · `surface` (node: Surface)\nWhy a tab?',
      ].join('\n\n'),
    )
    // It woke the coordinator as a typed message would.
    expect(entries.at(-1)?.kind).toBe('pi.assistant')
    const unknown = await post(server, '/api/extensions/architect/actions/send', {
      args: {
        conversation: branch,
        branch,
        version: 9,
        comments: [{ diagram: 'components', kind: 'diagram', label: '', text: 'x' }],
      },
    })
    expect(JSON.stringify(unknown.data)).toContain('has no version 9')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
