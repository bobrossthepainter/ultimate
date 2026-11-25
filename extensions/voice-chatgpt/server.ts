import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { failure, loggedIn, NO_LOGIN, postTranscribe } from './chatgpt.ts'
import { Transcriber } from '../dictation/api.ts'
import type { TranscriberService } from '../dictation/api.ts'

export const transcriber = (host: Pick<ExtensionHost, 'modelRuntime'>): TranscriberService => ({
  status: async () =>
    loggedIn(host.modelRuntime) ? { available: true } : { available: false, reason: NO_LOGIN },
  async transcribe(audio, signal) {
    const form = new FormData()
    const extension = audio.type.includes('mp4')
      ? 'mp4'
      : audio.type.includes('ogg')
        ? 'ogg'
        : 'webm'
    form.set('file', audio, `recording.${extension}`)
    form.set('model', 'gpt-transcribe')
    const encoded = new Response(form)
    const answer = await postTranscribe(
      host.modelRuntime,
      {
        type: encoded.headers.get('content-type')!,
        data: Buffer.from(await encoded.arrayBuffer()),
      },
      signal,
    )
    if (answer.status >= 300) throw new Error(failure(answer))
    let text: unknown
    try {
      text = JSON.parse(answer.text)?.text
    } catch {
      text = undefined
    }
    if (typeof text !== 'string')
      throw new Error('ChatGPT transcription failed: no text in the answer')
    return text
  },
})

export default (host: ExtensionHost) => {
  host.implement(Transcriber, transcriber(host))
  return defineExtension({ name: 'voice-chatgpt' })
}
