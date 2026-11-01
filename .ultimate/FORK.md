# Fork

This repository is a personal fork of Ultimate. `origin` is the fork, and `main` is the fork's line.

Upstream: https://github.com/HazAT/ultimate (remote `upstream`). To bring it in, fetch `upstream` and merge
`upstream/main` into `main` with an ordinary merge: never rebase, reset or force push. Keep each divergence small and
isolated so these merges stay cheap, and add a row below for every local change.

## Local divergences

| Change                            | Touches                                                                                                                        | Why                                                                                                                         | Upstream   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Supervisor network flags          | `bin/ultimate.ts`, `server/main.ts`, `extensions/instance/server.ts`, `extensions/review/surface.tsx`, `test/e2e/supervisor-*` | `--host`/`--allowed-origin` for private-network access, `--proxy-origin` for a loopback TLS reverse proxy                   | candidate  |
| voice-chatgpt extension           | `extensions/voice-chatgpt/`, `extensions/voice/` (transcriber extension point), `shared/extension-api.ts`, voice tests         | Dictation through the ChatGPT (openai-codex) subscription                                                                   | candidate  |
| Copilot model families            | none in the repository: `~/.ultimate/settings.json` on the machine that has Copilot                                            | Run the lead, review and fast families on GitHub Copilot models there; the project's `.ultimate/settings.json` keeps main's | local-only |
| Machine-independent test fixtures | `test/e2e/workspaces.test.ts`, `test/e2e/supervisor-helpers.ts`, `test/instance-previews.test.ts`                              | Git shim resolves git from `PATH`; the supervisor fixture reads the local URL                                               | local-only |
