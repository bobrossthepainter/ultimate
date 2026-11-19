import { expect, it } from 'vitest'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'
import { buildExtraBody } from '@earendil-works/pi-claude-code/src/transcript.ts'
import { createUltimateClaudeCodeProvider, withSupportedReasoning } from '../server.ts'

// #1: a conversation on claude-code/claude-opus-5-5 with thinking "off" (the harness default) failed with a 400,
// "thinking.type.disabled" is not supported for this model. Pi's catalog already drops "off" for that model, but the
// harness sends no reasoning for a stored "off", and the transport turns that into a disabled-thinking body.
const off: SimpleStreamOptions = {}

it('sends no disabled thinking to a model without an off level', () => {
  const models = createUltimateClaudeCodeProvider().getModels()
  const opus = models.find((model) => model.id === 'claude-opus-5-5')!
  expect(opus.thinkingLevelMap?.off).toBeNull()
  const options = withSupportedReasoning(opus, off)
  expect(options?.reasoning).toBe('low')
  expect(buildExtraBody(opus.id, [], options).thinking).toEqual({ type: 'adaptive' })
  expect(withSupportedReasoning(opus, { reasoning: 'high' })?.reasoning).toBe('high')

  const haiku = models.find((model) => model.id === 'claude-haiku-4-5-20251001')!
  expect(withSupportedReasoning(haiku, off)?.reasoning).toBeUndefined()
})
