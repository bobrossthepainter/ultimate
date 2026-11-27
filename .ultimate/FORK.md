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

- Touches: `bin/ultimate.ts`, `server/main.ts`, `extensions/instance/server.ts`, `extensions/review/file-diff.solid.tsx` (comment ids without
  `crypto.randomUUID`, missing on plain-HTTP LAN pages; re-applied on upstream's Solid review in the 2026-11-23 merge),
  `test/e2e/supervisor-*`
- Why: `--host`/`--allowed-origin` for private-network access (since the 2026-11-24 merge listed in upstream's
  `--help` usage), `--proxy-origin` for a loopback TLS reverse proxy (HTTP
  and SSE; no HMR socket)
- Upstream: candidate

### voice-chatgpt extension

- Touches: `extensions/voice-chatgpt/`, `extensions/dictation/` (upstream renamed `voice` to `dictation` in the
  2026-11-25 merge; the fork's `api.ts` with the `dictation.transcriber` point, `refs.ts` `secret`, and in upstream's
  `button.solid.tsx` the status re-check on extension or login changes and opening Secrets only for a named `secret`),
  `shared/extension-api.ts`, voice tests. Since the 2026-11-17 merge, `extensions/dictation/server.ts` reads the key with upstream's shared
  `openaiSecretOrNonOAuthKey` from `lib/openai.ts`; the fork keeps only its `VoiceHost` type with `want`
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
  through `exec.git`), `vite.config.ts` host-local allowlist (`extensions/sounds/command.ts`: upstream's narrator
  command plays on the machine running Ultimate, 2026-11-16 merge), `extensions/coding-tools/background.ts` (upstream's
  `bash` `background: true` starts through `exec.start`, so it runs where the working directory lives, 2026-11-17
  merge), `server/harness.ts` default runner and `extensions/exec/exec.ts` local `env` (upstream's work cgroup:
  local agent tool processes spawn through `workSpawn` so they land in the capped `work` cgroup, 2026-11-18 merge),
  `extensions/info/panel.solid.tsx` (the Execution section re-applied on upstream's Solid Info panel, 2026-11-20
  merge), `vite.config.ts` host-local allowlist (`extensions/antigravity/`: upstream's provider runs the
  `agy` CLI login on the machine running Ultimate, like Claude Code, 2026-11-22 merge), `extensions/lineage/catchup.ts`
  (upstream's untracked-file `ls-files` in `changedFiles` routed through `exec.git`, and
  `extensions/coding-tools/background.ts` keeps upstream's `dropHostNodeEnv` through `exec.start`, 2026-11-23 merge;
  `extensions/workspaces/` takes upstream's `serializeSourceWrites` queue for lander checkouts and discard with
  `exec.git`, and `server/actions.ts` keeps the routed `actionExec(run, cwd, signal)` beside upstream's `by`; the
  `vite.config.ts` host-local allowlist gains `extensions/acp/` (upstream's `agy acp` session over stdio pipes, like
  the Antigravity login), 2026-11-26 merge;
  `extensions/subagents/server.ts` keeps its stop-time `git diff` on the `Exec` service, dropping upstream's
  `lib/exec.ts` import, second 2026-11-23 merge), `vite.config.ts` host-local allowlist (`extensions/video/server.ts`:
  upstream's ffmpeg/ffprobe on uploaded videos in Ultimate's own home, 2026-11-24 merge; `lib/machine.ts` runs
  `scutil` for this machine's own name and stays local)
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
  config from Ultimate's own process. Upstream's `scripts/check-extension.ts` (2026-11-23 merge) only type-checks from
  a shell; Robert kept ours (card 633), and `places.md` names both
- Upstream: candidate

### SSH exec extension

- Touches: `extensions/ssh-exec/`, `extensions/setup/` (`SSH exec` area), `shared/extension-api.ts` (`defaultOff`),
  `test/e2e/ssh-exec.test.ts`
- Why: Off-by-default `ssh` protocol for `exec.protocol`: a root's commands run on an SSH target sharing its files
  (pod-local toolchain container)
- Upstream: candidate

### Lifecycle extension

- Touches: `extensions/lifecycle/`, `extensions/automations/` (`wakes`, `scripts`, `dueAt` kept alongside upstream's
  `IdleWaker` and `readByKey`), `shared/extension-api.ts` (`defaultOff`), `test/lifecycle.test.ts`,
  `extensions/automations/test/e2e/automations-scripts.test.ts`
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

- Touches: `extensions/mermaid/`, `package.json` + `pnpm-lock.yaml` (`mermaid`), `tsconfig.web.json` (`draw.ts`).
  Upstream's Markdown renderer became Solid in the 2026-11-20 merge, so `codeBlocks` renderers are Solid components:
  the diagram is `diagram.solid.tsx` (theme read from the `dark` class on `<html>`), Mermaid itself sits in `draw.ts`,
  loaded with the first diagram, and `ui.solid.tsx` re-exports `draw` and `token` for the architect. Since the
  2026-11-23 merge (upstream's Solid-only core) the facet is `web.solid.tsx`
- Why: `mermaid` code blocks in messages draw as diagrams in the theme's colours, Mermaid loaded with the first one
- Upstream: candidate

### Architect extension

- Touches: `extensions/architect/` (with `agents/architect.md`), `extensions/mermaid/ui.solid.tsx`,
  `extensions/review/ui.solid.tsx` (Solid `Recipient` export; upstream has no review contract, the fork keeps it for
  this), `shared/extension-api.ts`
  (`defaultOff`), `test/architect.test.ts`. Its refs and props use upstream's branded `ConversationId` (2026-11
  merge). Since the 2026-11-22 merge a source chip opens Review with upstream's `review:open` page event (upstream
  dropped `openReview`). Since the 2026-11-23 merge the whole extension is Solid (`*.solid.tsx`, kit controls,
  an `architect:open` page event for its chips; Discard and Delete comment carry `data-agent-confirm`). Since the
  2026-11-26 merge `extensions/architect/api.ts` declares `export const requires = ['mermaid', 'review']` for
  upstream's `declared-requires` lint: it runs mermaid's `draw` and review's `Recipient`)
- Why: Off-by-default Architecture tab: an architect agent draws a branch's architectural change as Mermaid versions;
  the user's comments on parts go to the coordinator as input
- Upstream: local-only

### Push iPhone install hint

- Touches: `extensions/push/notifications.solid.tsx` (`blocked`: Share, Add to Home Screen; upstream moved the chip to
  Solid in the 2026-11-20 merge)
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
  The 2026-11-16 merge brought `no-unowned-work`: fork fire-and-forget work is named with `rebuiltOnOpen` (usage
  history, Plannotator sweep, ssh-exec first checks) or `inProcess` (preview route and Plannotator decision after
  their process exits, ssh-exec recheck). The 2026-11-23 merge brought upstream's Solid-only core
  (`ui-framework-boundaries`: no React in `extensions/`): every fork facet (architect, usage, caddy, cache-warming,
  brave, upstream-sync, plannotator, check-extensions, mermaid) is now `web.solid.tsx` on the ui-sdk kit, with no lint
  exception, and the fork's contracts are `ui.solid.tsx` (exec, mermaid, review). A later 2026-11-23 merge dropped
  React and its compat layer completely (`extensions/sidebar/ui.tsx` removed), dropped per-file
  `/** @jsxImportSource @solidjs/web */` pragmas (now in `tsconfig.web.json`), and moved release cleanups onto
  `host.onOpen(opened => opened.defer(...))`. New fork code follows the same rules
- Upstream: local-only

### Cache warming per agent

- Touches: `extensions/keep-warm/` (exactly PR #410's version: per-conversation `keep-warm.ping` tasks, lifetime from
  `promptCache`, idle transcript `ok` pings, mid-run one-token replay kept in memory only, the `@ultimate` and
  `branch` chips, README, tests), `lib/agents.ts` (`cache:` definition field), `extensions/subagents/` (`CachePolicy`
  type, save, Prompt cache field in the Agents editor, test), `agents/ultimate.md` and `agents/coordinator.md`
  (`cache:` defaults), `tsconfig.web.json` (`keep-warm/duration.ts`), `test/ui-changed.test.ts` (`set { id, warm }`)
- Why: one warmer for @ultimate and branch coordinators on any cache lifetime, configured per agent and overridden
  per conversation from its chip, so 5-minute caches such as Copilot's stay warm idle and through long tool runs.
  Since 2026-11-26 the fork runs PR #410's code as is; the fork's own `extensions/cache-warming` is gone (no
  per-chat overrides existed to migrate) and `keep-warm` is on by default again, as upstream has it.
- Upstream: given back as PR #410 (https://github.com/HazAT/ultimate/pull/410; supersedes closed #275)
- Follow-up: keep `extensions/keep-warm/` identical to the PR branch `give-back/cache-warming`: a fix goes into the
  PR branch first, then here. If upstream merges #410, the divergence ends. If upstream changes keep-warm
  meanwhile, resolve towards #410 and update the PR. Its screenshots live on the fork's `pr-assets/keep-warm`
  branch, which must stay

### Projects rail over Caddy

- Touches: `extensions/projects/` (`refs.ts` `served`, `links.ts`, `server.ts` wants `CaddyApi`, `web.tsx` label),
  `extensions/caddy/` (`CaddyApi.served()`); the label lives in upstream's Solid `rail.solid.tsx` since the 2026-11-20
  merge
- Why: Upstream's rail links other Ultimates only over loopback or on their Tailscale port, so on a page served by
  the fork's Caddy hosting (`https://<domain>:<port>`) every other project was greyed out "not on the tailnet".
  Caddy now names each routed project's origin, and the rail links there when the page's host matches; the dimmed
  label says "not served on this address"
- Upstream: candidate (a generic "served origins" field any reverse proxy could fill)

### Usage extension

- Touches: `extensions/usage/` (`server.ts` unsubscribes its `onCommit` observer via `opened.defer`), `lib/remote.ts`
  (`reachable` and `spokesOf`: every other instance this one reaches, once per address), `test/remote-spokes.test.ts`
- Why: Usage surface: list-price cost of this instance's model calls by day, cost type, cache rebuilds (with cause),
  role, model and branch (with cache hit rate and rebuilds), and the same for every other Ultimate it reaches (hub
  and spokes); spokes without the extension show their `pi.usage` totals. Today and custom date ranges (`frame.ts`,
  #40887) joined it in the 2026-11-23 merge, when the surface became Solid (`web.solid.tsx`; `frame.ts` in
  `tsconfig.web.json`)
- Upstream: local-only (written generically, so it could be given back)

### @ultimate routes forwarded insights

- Touches: `agents/ultimate.md` (one sentence in "Coordinators and messages")
- Why: A research handover or insight forwarded from another project or session sat as background instead of being
  acted on; @ultimate now routes it to a branch in the same turn and tells the user where it went
- Upstream: candidate

### Previews through Caddy

- Touches: `extensions/instance/` (`server.ts` start/stop/list publish through an optional `want(CaddyApi)`, `web.tsx`
  card; since the 2026-11-20 merge links in upstream's `link.solid.tsx`, the switcher in `switcher.solid.tsx`, and
  `onCaddy`/`reachable` in `previews.ts`, `refs.ts` `caddy`, README; since the 2026-11-21 merge the card's Caddy link
  sits in upstream's Solid `call.solid.tsx`; since the 2026-11-23 merge upstream's `web.solid.tsx` keeps the
  switcher on without `canFrameLoopbackPreviews`, and `switcher.solid.tsx` reads through `useExternal`), `extensions/caddy/` (`publishRoute`/`unpublishRoute`,
  README), `server/main.ts` (an unsupervised server honours `ULTIMATE_PROXY_ORIGIN`, beside upstream's SIGINT/SIGTERM
  handlers, which moved into that branch in the 2026-11-17 merge),
  `.ultimate/skills/preview-demo/`, `skills/ui-preview-round/SKILL.md`, `extensions/instance/test/e2e/instance.test.ts`.
  Since the 2026-11-16 merge, start writes upstream's crash pid file before publishing to Caddy, and stop unpublishes
  after the pid-file-aware `stopGroup`
- Why: Previews were reachable only on loopback, so their links were useless from other LAN devices. When the host
  project is served by Caddy, `instance start` and the preview demo publish the preview at
  `https://<domain>:9490–9499`, and that link is the one handed to the user; without Caddy nothing changes
- Upstream: local-only (Caddy is fork-only; the `server/main.ts` line is a candidate on its own)

### Side chats from branches

- Touches: `extensions/side-chat/` (open from a branch, fork at the newest finished step, read-only branch copies,
  labels naming main), `extensions/lineage/server.ts` (`branchOf` and catch-up skip side chats), `lib/acting-as.ts`
  (`isSideChat`), `extensions/sidebar/` (`sidebar.under-branch` point; since the 2026-11-22 merge it lives
  in upstream's `points.ts` with an object input `{ conversation }`, rendered by the Solid in-flight row in
  `root.solid.tsx`), `agents/coordinator.md` (one
  paragraph). Since the 2026-11-18 merge it sits beside upstream's question side chats (`open {message}`, read-only
  by `question`): branch copies keep `readOnly`, question copies keep upstream's `readOnlyCall` list; `Stage`, `Cut`
  and the header name the main (`@ultimate`, `#id · title`, or the asker); `isSideChat` in `lib/acting-as.ts` is now
  upstream's. Since the 2026-11-21 merge the composer frame is upstream's Solid `frame.solid.tsx`, with the fork's
  branch main re-applied (`mainName`/`shortName` in `logic.ts`). Since the 2026-11-23 merge the rest is upstream's
  Solid `web.solid.tsx` with the fork re-applied: `UnderBranch` rows, the main's name in `Stage`, the header and `Cut`,
  and `Unlisted` by the `side-chat` label; `UnderBranch` is a Solid point exported from `sidebar/ui.solid.tsx`. A later
  2026-11-23 merge moved upstream's `codemode` onto Pi Durable's `createCodemodeExtension` so nested calls (including
  `action` and `tell`) run through `ToolTask.beforeTool`, letting the fork drop `lib/side-chat-guard.ts` and all
  divergence in `extensions/codemode/server.ts` (`blockedInReadOnlySideChat` now lives in `extensions/side-chat/server.ts`
  blocking `action`, `tell` and `remember`). The 2026-11-24 merge moved upstream's fork helpers into
  `lib/settled-answer.ts`; the fork imports `answerIncludingClosingToolResults` from there (question side chats) and
  keeps only `newestClosedRound`
- Why: ask a running branch questions without disturbing it; a branch is usually mid-run, so the fork point moved
  from the last answered input to the newest finished tool round, for @ultimate too
- Upstream: candidate

### Upstream diagrams off

- Touches: `shared/extension-api.ts` (`diagrams` in `defaultOff`, so every Ultimate on this code base starts with it
  off; `extensions.enable` turns it back on)
- Why: upstream's `diagrams` (Unicode box-art via `lovely-mermaid`) claims the same `mermaid` code blocks as the
  fork's SVG `extensions/mermaid`, which the user approved; one renderer per job. `lovely-mermaid` stays installed
  but unused. Re-check on each merge whether upstream changed either renderer
- Upstream: local-only

### Cloud identity for any Git host

- Touches: `lib/project-identity.ts` (`remoteKey`; `projectIdentity` uses it, `projectKey`/`githubRepo` stay
  GitHub-only), `test/cloud-identity.test.ts`, the "no Git host origin" wording in `extensions/cloud/`,
  `extensions/dream/` and `scripts/restore.ts`
- Why: projects whose origin is a Gitea/Forgejo or GitLab host get backed up as `<host>/<owner>/<repo>`; GitHub keys
  stay byte-identical
- Upstream: candidate

### Worker on the lead family

- Touches: `.ultimate/agents/worker.md` (`family: lead` in upstream's project overlay, 2026-11-26 merge)
- Why: the user runs workers on the lead family; this was an untracked local override until upstream began tracking
  the overlay file
- Upstream: local-only

### Antigravity provider kept

- Touches: `extensions/antigravity/` (restored from upstream's `fe1c9caa^`, its executable read from `acp`'s
  `ULTIMATE_AGY_COMMAND`), `shared/extension-api.ts` (`antigravity` in `defaultOff`), `docs/settings.md`; the
  host-local exec allowlist in `vite.config.ts` still names it
- Why: the user decided to keep running Gemini models from the `agy` login as normal Ultimate models (card 751,
  "Restore, separate account"). Wrapping `agy` this way is against Google's consumer terms, which is why upstream
  removed it; the user accepts that risk and runs it only with a separate Google account signed into `agy`, which can
  be suspended. Each upstream merge must re-check it against `agy` and relay changes (`agy -p`, `agy models`,
  `CLOUD_CODE_URL`, Code Assist frames) and against `acp`, which shares the login
- Upstream: local-only (never a give-back candidate)
