Dictation through your ChatGPT subscription: the composer's mic transcribes with your ChatGPT Plus/Pro login instead of an OpenAI API key.

This built-in is off by default. Turn it on with `"extensions": { "enable": ["voice-chatgpt"] }` in your user or
project `.ultimate/settings.json`, or in the Extensions panel; turning it off goes back to `OPENAI_API_KEY`. Either
applies at once, without a restart. It needs the `voice` extension, whose mic button it uses unchanged.

## How it works

- It provides voice's `voice.transcriber` point (`extensions/voice/api.ts`). While it is enabled, voice's `status`
  and `transcribe` go through it; while it is off, voice uses the API key as before.
- **Login:** Pi's `openai-codex` login, shown as **OpenAI (ChatGPT Plus/Pro)** in the model picker: the same
  sign-in Codex uses. Pi refreshes the token. The OpenAI provider's "Sign in with ChatGPT" login does not work here:
  OpenAI's API rejects its token for transcription. Without the login the mic is dimmed and says so.
- **Request:** the recording is posted to `https://chatgpt.com/backend-api/transcribe` (model `gpt-transcribe`), the
  endpoint ChatGPT's own dictation uses, with the token, the `chatgpt-account-id` from its claims and
  `originator: ultimate`. `chatgpt.ts` sends it with `node:https`: Cloudflare challenges Node's `fetch` on this
  endpoint (HTTP 403), but not these requests. The token is never logged or returned, and a failed token refresh
  becomes a fixed "log in again" message, since Pi's error can carry the token response.
- **Failures** show beside the mic: no login, a rejected login (401), a Cloudflare challenge, rate limiting (429),
  and any other HTTP status with ChatGPT's reason.

## Risks

- The endpoint is undocumented: it may change or stop accepting this client without notice.
- Cloudflare challenges requests from some networks and servers. Then transcription fails with that reason; turn
  the extension off to use an API key.
- ChatGPT keeps each recording as a file in your account for 30 days (the answer's `asset_ttl`).
- Usage counts against your ChatGPT subscription's limits.

## Live voice stays on the API key

There is no subscription counterpart for `voice-live`. `chatgpt.com/backend-api/codex/live/sessions` accepts this
login and returns a session with a WebRTC answer, but once the browser connects, the session sends
`error: "Voice session access denied." (forbidden)` and closes before any audio (tested in a real browser session,
with `gpt-live-1` and `gpt-live-1-codex`, as `ultimate` and as `codex_cli_rs`). `api.openai.com/v1/live/sessions`
rejects the token outright. Live voice therefore keeps using `OPENAI_API_KEY`.

`test/voice-chatgpt.test.ts` covers the switch with and without the extension and the failure messages, without
network.
