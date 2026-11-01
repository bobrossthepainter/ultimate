/**
 * Voice: the `voice.transcriber` point through which another extension takes over transcription from the OpenAI API
 * key (voice-chatgpt sends it through the ChatGPT subscription).
 */
import { defineApi } from '../../shared/extension-api.ts'
import type { VoiceStatus } from './refs.ts'

export type { VoiceStatus }

export type TranscriberService = {
  /** Whether it can transcribe now; when not, `reason` says what to do. */
  status(signal: AbortSignal): Promise<VoiceStatus>
  /** The words spoken in `audio`; throws with the message the composer shows. */
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>
}
/** Replaces voice's API-key transcription while an enabled extension provides it. */
export const Transcriber = defineApi<TranscriberService>()('voice.transcriber')
