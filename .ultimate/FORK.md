# Fork

This repository is a personal fork of Ultimate. `origin` is the fork, and `main` is the fork's line.

Upstream: https://github.com/HazAT/ultimate (remote `upstream`). To bring it in, fetch `upstream` and merge
`upstream/main` into `main` with an ordinary merge: never rebase, reset or force push. Keep each divergence small and
isolated so these merges stay cheap, and add a section below for every local change.

## Local divergences

One `###` section per divergence, named after the change, with three fields: **Touches** (the files and areas it
changes), **Why**, and **Upstream** (`local-only`, `candidate` or `given back as PR #N`). Add new sections at the end,
so branches adding divergences in parallel do not edit the same lines.

### Supervisor network flags

- Touches: `bin/ultimate.ts`, `server/main.ts`, `extensions/instance/server.ts`, `extensions/review/surface.tsx`,
  `test/e2e/supervisor-*`
- Why: `--host`/`--allowed-origin` for private-network access, `--proxy-origin` for a loopback TLS reverse proxy (HTTP
  and SSE; no HMR socket)
- Upstream: candidate

### voice-chatgpt extension

- Touches: `extensions/voice-chatgpt/`, `extensions/voice/` (transcriber extension point), `shared/extension-api.ts`,
  voice tests
- Why: Dictation through the ChatGPT (openai-codex) subscription
- Upstream: candidate

### Copilot model families

- Touches: none in the repository: `~/.ultimate/settings.json` on the machine that has Copilot
- Why: Run the lead, review and fast families on GitHub Copilot models there; the project's `.ultimate/settings.json`
  keeps main's
- Upstream: local-only

### upstream-sync extension

- Touches: `extensions/upstream-sync/`, `test/e2e/upstream-sync.test.ts`, `.ultimate/skills/merge-upstream/`
- Why: `↓ N upstream` item compares main with `upstream/main`, and Update with @ultimate merges it; update stays on
  origin, as upstream ships it
- Upstream: local-only

### Register publishes proxy origin

- Touches: `extensions/cloud/server.ts`, `extensions/cloud/README.md`, `extensions/cloud/test/cloud-api.test.ts`,
  `.ultimate/lan-https.md`
- Why: Without Tailscale, backups register the HTTPS `--proxy-origin` so other Ultimates find LAN-hosted ones; Caddy
  setup in `lan-https.md`
- Upstream: candidate

### Caddy hosting extension

- Touches: `extensions/caddy/`, `test/caddy.test.ts`, `.ultimate/lan-https.md`
- Why: Hosting panel: tick each Ultimate to serve it on its own port of one domain through one extension-run Caddy
  (DNS-01 or own cert)
- Upstream: candidate

### Per-project services

- Touches: `scripts/setup-machine.ts`, `bin/ultimate.ts` (exit 3), `docs/running.md`, `test/setup-machine.test.ts`,
  `test/e2e/supervisor-process.test.ts`
- Why: `ultimate@<home>.service` template per project with a fixed port in `<home>/service.env`, migrating
  `ultimate.service`; no retry loop
- Upstream: candidate

### Service buttons in Hosting

- Touches: `extensions/caddy/` (`service` action, panel row buttons)
- Why: Start, Stop (never itself) or Install as service per project from the Hosting panel; rides with the Caddy
  extension
- Upstream: candidate

### Exec facade

- Touches: `extensions/exec/`, `server/harness.ts`, `server/extensions.ts` and `server/actions.ts` (`execution`: env
  and run, actions' `ctx.exec`), `lint/ultimate.ts` + `vite.config.ts` (`no-unrouted-exec`; skips
  `extensions/*/test/**`, which upstream moved tests into), `docs/extensions/actions.md` (`ctx.exec`, where commands
  run) + `docs/extensions/core-tier.md` (exec in layer 1) + `skills/write-extension/`, `lib/git.ts` (`gitWith`),
  `lib/process-group.ts` (`runGroup` start), routed callers in workspaces, review, lineage, prompt, coding-tools,
  subagents, cloud, setup, onboarding, `extensions/info/` (Execution section), `shared/protocol.ts` and
  `server/system.ts` (`execution.kind` removed), `extensions/coding-tools/server.ts` (`prepareBash` takes the routed
  `git` for upstream's worktree-scoped hooks), `extensions/review/server.ts` (upstream's branch fallback in `target`
  through `exec.git`)
- Why: Core-tier service running project and worktree commands where their directory lives; `exec.protocol` point for
  remote targets (pod-local proof). The give-back set includes 21b7d4cc: each protocol's `describe` and exec's
  `target` action, so the Info panel shows where a conversation's commands run. Extension actions' `ctx.exec` runs
  through the service too, and lint keeps extension code (a project's own included) from spawning past it
- Upstream: candidate

### check-extensions extension

- Touches: `extensions/check-extensions/`, `test/e2e/check-extensions.test.ts`, `docs/extensions/places.md` +
  `docs/extensions/example-app.md` (checking other projects' extensions), `docs/extensions/actions.md` (stale
  fail-closed `ctx.exec` text removed), `skills/write-extension/`
- Why: `check_extensions` tool: format, lint and type-check any project's `.ultimate/extensions/` with the clone's
  config from Ultimate's own process
- Upstream: candidate

### SSH exec extension

- Touches: `extensions/ssh-exec/`, `extensions/setup/` (`SSH exec` area), `shared/extension-api.ts` (`defaultOff`),
  `test/e2e/ssh-exec.test.ts`
- Why: Off-by-default `ssh` protocol for `exec.protocol`: a root's commands run on an SSH target sharing its files
  (pod-local toolchain container)
- Upstream: candidate

### Lifecycle extension

- Touches: `extensions/lifecycle/`, `extensions/automations/` (`wakes`, `scripts`, `dueAt`), `shared/extension-api.ts`
  (`defaultOff`), `test/lifecycle.test.ts`, `extensions/automations/test/e2e/automations-scripts.test.ts`
- Why: Off-by-default `state` action: whether anything runs and when the instance must wake, for an operator that
  scales idle instances to zero
- Upstream: candidate

### Chromium sandbox hint

- Touches: `extensions/browser/server.ts` (`sandboxHint`), `extensions/browser/README.md`,
  `extensions/browser/test/browser-binary.test.ts`
- Why: A launch that fails with "No usable sandbox" names `ULTIMATE_CHROMIUM_SANDBOX=0` and that it leaves the
  container as the only boundary
- Upstream: candidate

### Brave search extension

- Touches: `extensions/brave/`, `shared/extension-api.ts` (`defaultOff`), `test/brave.test.ts`
- Why: Off-by-default `web_search` through Brave's LLM Context API instead of parallel (only one on); search card
  copied from parallel, no `web_fetch`
- Upstream: candidate

### Plannotator extension

- Touches: `extensions/plannotator/`, `extensions/caddy/` (`api.ts`, `CaddyApi.publish`), `agents/ultimate.md`
  (tool), `shared/extension-api.ts` (`defaultOff`), `vite.config.ts` (host-local), `test/caddy.test.ts`,
  `test/e2e/plannotator.test.ts`
- Why: Off-by-default `review_with_plannotator`: a pinned Plannotator on one or more repositories, published through
  Caddy on the LAN domain; the user's feedback returns as input
- Upstream: local-only

### Machine-independent test fixtures

- Touches: `extensions/workspaces/test/e2e/workspaces.test.ts`, `test/e2e/supervisor-helpers.ts`,
  `extensions/instance/test/instance-previews.test.ts`
- Why: Git shim resolves git from `PATH`; the supervisor fixture reads the local URL
- Upstream: local-only

### Mermaid extension

- Touches: `extensions/mermaid/`, `package.json` + `pnpm-lock.yaml` (`mermaid`)
- Why: `mermaid` code blocks in messages draw as diagrams in the theme's colours, Mermaid loaded with the first one
- Upstream: candidate

### Architect extension

- Touches: `extensions/architect/` (with `agents/architect.md`), `extensions/mermaid/ui.tsx`, `extensions/review/ui.tsx`
  (`Recipient` export; upstream deleted the file as unused, the fork keeps it for this), `shared/extension-api.ts`
  (`defaultOff`), `test/architect.test.ts`. Its refs and props use upstream's branded `ConversationId` (2026-11
  merge)
- Why: Off-by-default Architecture tab: an architect agent draws a branch's architectural change as Mermaid versions;
  the user's comments on parts go to the coordinator as input
- Upstream: local-only

### Push iPhone install hint

- Touches: `extensions/push/web.tsx` (`blocked`: Share, Add to Home Screen)
- Why: iOS only receives pushes once installed to the home screen; upstream's message does not say how. The fork's
  `getNotifications` guard and its test were dropped in the 2026-11 merge: upstream's `hasPushSupport` check (32e64840)
  covers it
- Upstream: candidate

### Fork code under upstream's code rules

- Touches: every fork-only extension and fork hunk in `bin/`, `lib/`, `scripts/`, `server/`, `shared/`
- Why: Upstream turned on `no-comments`, `no-raw-timer`, `no-silent-catch` and `replay-safe-by-name` for all product
  code and dropped every `oxlint-disable`. The 2026-11 merge removed the fork's comments (the why of each now lives in
  this file and the commits), moved timers onto `lib/timers.ts`, named swallowed errors from `lib/errors.ts`, spread
  `readOnly`/`safeToRerun` on fork tools, and replaced two architect `exhaustive-deps` disables with `useEffectEvent`.
  New fork code follows the same rules
- Upstream: local-only

### branch-cache extension

- Touches: `extensions/branch-cache/` (new; off by default per branch)
- Why: Branch coordinators rebuilt their prompt cache after long waits on the user, subagents or the lander (#27553:
  41 % of coordinator cost). Per branch, a `cache` chip turns on keep-warm pings (as `keep-warm` does for @ultimate,
  8 h after the branch's last input of any kind) and compaction before the cache runs cold, also during waits on
  subagents; with both on it compacts when the warm window ends (#27794). `due.ts` and the ping are adapted copies of
  `extensions/keep-warm/` (2a6726f), since lint lets server code reach another extension only through its `api.ts`:
  re-sync them when upstream changes keep-warm's ping. Its `beforeCompact` hook (`order = -1`, before lineage) asks
  for the summary on the branch's own cached context instead of lineage's uncached source text
- Upstream: candidate

### Projects rail over Caddy

- Touches: `extensions/projects/` (`refs.ts` `served`, `links.ts`, `server.ts` wants `CaddyApi`, `web.tsx` label),
  `extensions/caddy/` (`CaddyApi.served()`)
- Why: Upstream's rail links other Ultimates only over loopback or on their Tailscale port, so on a page served by
  the fork's Caddy hosting (`https://<domain>:<port>`) every other project was greyed out "not on the tailnet".
  Caddy now names each routed project's origin, and the rail links there when the page's host matches; the dimmed
  label says "not served on this address"
- Upstream: candidate (a generic "served origins" field any reverse proxy could fill)

### Usage extension

- Touches: `extensions/usage/`, `lib/remote.ts` (`reachable` and `spokesOf`: every other instance this one reaches,
  once per address), `test/remote-spokes.test.ts`
- Why: Usage surface: list-price cost of this instance's model calls by day, cost type, cache rebuilds (with cause),
  role, model and branch (with cache hit rate and rebuilds), and the same for every other Ultimate it reaches (hub
  and spokes); spokes without the extension show their `pi.usage` totals
- Upstream: local-only (written generically, so it could be given back)

### @ultimate routes forwarded insights

- Touches: `agents/ultimate.md` (one sentence in "Coordinators and messages")
- Why: A research handover or insight forwarded from another project or session sat as background instead of being
  acted on; @ultimate now routes it to a branch in the same turn and tells the user where it went
- Upstream: candidate

### Stable selectors in verify-ui

- Touches: `skills/verify-ui/SKILL.md` (one bullet under "How")
- Why: In #27553, 6 of 7 browser failures came from ambiguous selectors and guessing the ⌘K palette. The bullet names
  the attributes the app already sets (`data-ui="surface-tabs"`, `data-surface`, `data-ui="palette"`, cmdk's
  `data-value`), checked against the running UI
- Upstream: candidate

### Previews through Caddy

- Touches: `extensions/instance/` (`server.ts` start/stop/list publish through an optional `want(CaddyApi)`, `web.tsx`
  card, links and switcher, `refs.ts` `caddy`, README), `extensions/caddy/` (`publishRoute`/`unpublishRoute`,
  README), `server/main.ts` (an unsupervised server honours `ULTIMATE_PROXY_ORIGIN`),
  `.ultimate/skills/preview-demo/`, `skills/ui-preview-round/SKILL.md`, `extensions/instance/test/e2e/instance.test.ts`
- Why: Previews were reachable only on loopback, so their links were useless from other LAN devices. When the host
  project is served by Caddy, `instance start` and the preview demo publish the preview at
  `https://<domain>:9490–9499`, and that link is the one handed to the user; without Caddy nothing changes
- Upstream: local-only (Caddy is fork-only; the `server/main.ts` line is a candidate on its own)
