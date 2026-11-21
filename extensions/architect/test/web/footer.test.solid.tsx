/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('../../../review/ui.solid.tsx', () => ({ Recipient: () => null }))
vi.mock('../../../messages/ui.solid.tsx', () => ({ Address: () => null }))

async function mount() {
  const { Footer } = await import('../../footer.solid.tsx')
  const log: string[] = []
  const root = renderSolid(() => (
    <Footer
      drafts={{ comments: [], note: 'old' }}
      edit={
        (async (change: { note?: string }) => {
          log.push(`edit ${change.note}`)
          await Promise.resolve()
        }) as never
      }
      onSend={() => log.push('send')}
      sending={false}
      to={parseConversationId(3)}
    />
  ))
  flush()
  const area = () => root.querySelector('textarea')!
  const send = () =>
    [...root.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Send'))!
  const type = async (text: string) => {
    const agent = createAgent()
    const ref = agent.snapshot().find((entry) => entry.label === 'Overall note')!.ref
    await agent.act({ steps: [{ ref, action: 'setValue', args: [text] }] })
    flush()
  }
  const blur = () => area().dispatchEvent(new FocusEvent('blur'))
  const done = async () => {
    await settle()
    flush()
  }
  return { log, send, type, blur, done }
}

it('two Send clicks during a pending note save send once', async () => {
  const footer = await mount()
  await footer.type('new note')
  footer.send().click()
  flush()
  footer.send().click()
  await footer.done()
  expect(footer.log).toEqual(['edit new note', 'send'])
})

it('re-entering a note saved earlier saves it again before sending', async () => {
  const footer = await mount()
  await footer.type('A')
  footer.blur()
  await footer.done()
  await footer.type('A ')
  await footer.type('A')
  footer.send().click()
  await footer.done()
  expect(footer.log).toEqual(['edit A', 'edit A', 'send'])
})
