/** Voice input in the browser: whether transcription is set up, and the transcription action. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * Whether voice input works: `available`, else `reason` says what to do, and `secret` names the missing secret whose
 * row the button opens in Secrets.
 */
export type VoiceStatus =
  | { available: true }
  | { available: false; reason: string; secret?: string }

/** No arguments → whether voice input can transcribe now. */
export const StatusAction = actionRef<null, VoiceStatus>('voice', 'status')
/** `{ audio: base64, mimeType }` → the transcribed text. Fails with a message the composer shows as is. */
export const TranscribeAction = actionRef<{ audio: string; mimeType: string }, { text: string }>(
  'voice',
  'transcribe',
)
