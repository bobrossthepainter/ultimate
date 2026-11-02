# Fork

This repository is a personal fork of Ultimate. `origin` is the fork, and `main` is the fork's line.

Upstream: https://github.com/HazAT/ultimate (remote `upstream`). To bring it in, fetch `upstream` and merge
`upstream/main` into `main` with an ordinary merge: never rebase, reset or force push. Keep each divergence small and
isolated so these merges stay cheap, and add a row below for every local change.

## Local divergences

| Change                            | Touches                                                                                                                                                                             | Why                                                                                                                                     | Upstream   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Supervisor network flags          | `bin/ultimate.ts`, `server/main.ts`, `extensions/instance/server.ts`, `extensions/review/surface.tsx`, `test/e2e/supervisor-*`                                                      | `--host`/`--allowed-origin` for private-network access, `--proxy-origin` for a loopback TLS reverse proxy                               | candidate  |
| voice-chatgpt extension           | `extensions/voice-chatgpt/`, `extensions/voice/` (transcriber extension point), `shared/extension-api.ts`, voice tests                                                              | Dictation through the ChatGPT (openai-codex) subscription                                                                               | candidate  |
| Copilot model families            | none in the repository: `~/.ultimate/settings.json` on the machine that has Copilot                                                                                                 | Run the lead, review and fast families on GitHub Copilot models there; the project's `.ultimate/settings.json` keeps main's             | local-only |
| Update watches upstream           | `lib/fast-forward.ts`, `lib/project-identity.ts`, `extensions/update/`, `test/e2e/update*.test.ts`, `.ultimate/settings.json` (`update.remote`), `.ultimate/skills/merge-upstream/` | The update item compares main with `upstream/main`, and Update with @ultimate merges it; origin is the fork, kept current by the lander | local-only |
| Register publishes proxy origin   | `extensions/cloud/server.ts`, `extensions/cloud/README.md`, `test/cloud-api.test.ts`, `.ultimate/lan-https.md`                                                                      | Without Tailscale, backups register the HTTPS `--proxy-origin` so other Ultimates find LAN-hosted ones; Caddy setup in `lan-https.md`   | candidate  |
| Machine-independent test fixtures | `test/e2e/workspaces.test.ts`, `test/e2e/supervisor-helpers.ts`, `test/instance-previews.test.ts`                                                                                   | Git shim resolves git from `PATH`; the supervisor fixture reads the local URL                                                           | local-only |
