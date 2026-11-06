Review code with the user in [Plannotator](https://plannotator.ai): an agent opens a session on one or more repositories, the user jumps to it from the card, and their feedback or approval comes back to that conversation.

Off by default; enable `plannotator` in `extensions.enable`. A fork-only extension (`.ultimate/FORK.md`).

## Install

⌘K **Install Plannotator** downloads the pinned release (`VERSION` in `server.ts`) for this platform from GitHub,
checks its SHA-256 against the one pinned beside it, and keeps it as `~/.ultimate/plannotator/plannotator-<version>`.
Nothing goes on the `PATH` or into `~/.plannotator`: its data folder is `~/.ultimate/plannotator/data`. Its agent
hooks and skills are not installed. A new version means a new pin: update `VERSION` and the hashes together, and check
the flags below against `plannotator review --help`.

## Starting a review

- **Agents:** the `review_with_plannotator` tool, `{ items: [{ repo?, conversation?, base? }], mode?, title? }`. An item
  is a directory in a Git repository, or a conversation's worktree (the project checkout once it has none). `base`
  defaults to the worktree's target branch, else `origin`'s default branch, else `main` or `master`.
- **The user:** ⌘K **Review with Plannotator** reviews the shown conversation's worktree and opens it in a new tab.

What a session shows:

- **One repository:** Plannotator's live view, `plannotator review --base <base> <dir>`: commits, staged, unstaged and
  untracked changes since the base, with its comparison picker to switch.
- **Several, `combined` (default):** one fixed patch, each repository since the merge base with its own base, commits
  and untracked files included, paths prefixed with the repository's folder name (`--patch-file`). No picker.
- **Several, `live`:** Plannotator's own multi-repository view of a folder of links to them. It shows only their
  uncommitted changes and last commits, and takes no base (Plannotator refuses `--base` there).

Every session runs with `BROWSER=none`, sharing off (`PLANNOTATOR_SHARE`), no `git ls-remote`
(`PLANNOTATOR_GIT_REMOTE_CHECK=0`), and `updateCheck: false` in its config, so it asks GitHub for no release record.
Its AI features stay on: **AI Chat** (Ask AI) answers through a provider the user picks from those installed here
(Pi, Claude or Codex; the choice is kept in its data folder), and **Review Agents** and **Guided Review** run the
`claude` or `codex` CLI. Questions and diff context go to that provider. Since Ultimate starts the session, Pi answers
as a separate agent that sees the diff, not as the conversation that asked (Plannotator's "Ask this session" works
only when Pi or Claude Code itself opens it). It runs on this machine, like Caddy: a project whose commands run elsewhere (ssh-exec) reviews files
this machine can read, and the patch is built through the exec service.

## Reaching it

Sessions listen on loopback, one of ports 19432–19435, so at most four run at once. While this project is served by
Caddy (Hosting panel), each session is also published through `CaddyApi.publish` at `https://<domain>:<9480 + n>`, and
Plannotator is told to answer that hostname (`PLANNOTATOR_ALLOWED_HOSTS`; it refuses other `Host` headers). Like the
Ultimates behind Caddy, there is no login: publish the domain only on the LAN. Without Caddy, the card links the
loopback address, which only this machine opens.

## The result

The tool call renders as a card with **Open** and **Stop** while the session runs, then its outcome. When the user
clicks **Approve** or **Send Feedback**, Plannotator prints `{ decision, message }` (`--json`) and exits; the message,
Plannotator's Markdown feedback with file and line references, becomes a `plannotator.result` input of the
conversation that started the review (steering it when busy), shown on the user's side. Closing without feedback, or
**Stop**, sends nothing. Sessions end with the server; a session of a server that restarted shows as stopped.

## Actions

- `overview` → `{ version, installed, sessions }`.
- `start { items, mode?, title? }` → the session, for the calling conversation.
- `stop { id }` → `{ stopped }`.
- User-only: `install` → `{ version }`.

`PLANNOTATOR_COMMAND` names another binary; tests point it at a stub.
