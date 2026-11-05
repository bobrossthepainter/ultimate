Watches the repository a fork of Ultimate came from (the clone's `upstream` remote) and asks @ultimate to merge its new commits on a branch. Without an `upstream` remote it does nothing.

## Why next to update

A fork's `origin` is the fork itself, kept current by the lander, so the `update` extension (which compares with origin) stays quiet there. It keeps doing what it does for every landing: installing packages when the lockfile changed and asking for a restart. This extension adds only the second remote, and leaves `extensions/update` and `lib/fast-forward.ts` as upstream ships them, so upstream merges never conflict there.

## Checking

Every running Ultimate compares the clone (`host.ultimateRoot`) with `upstream/<default branch>` every 5 minutes, 30 s after start, locally. It fetches upstream only when the last upstream fetch is older than an hour, read from the mtime of `.git/ultimate-upstream-fetched`, which each successful fetch writes. The fetch runs with `--no-write-fetch-head`: update times its own hourly origin fetch by `FETCH_HEAD`'s mtime, which an upstream fetch must not refresh. Fetches and summaries hold the clone-wide lock update also holds (`.git/ultimate-update.lock`, from `server/lock.ts`), so the Ultimates on one clone fetch once between them. Pause stops the background checks; previews never check.

A new range is summarized once by the summary model (`ConversationsApi.askSummaryModel`) from its commit messages, clipped to 12,000 characters, and cached by `<head>..<upstream head>` in `.git/ultimate-upstream-summary.json`.

## The item

`↓ N upstream` while upstream has commits the clone lacks; nothing while it has none, since update's item already says the clone is current. Its popover shows the summary, the newest commits, a DiffsHub link for a GitHub upstream, the fork's own commit count, and **Update with @ultimate**. The item turns amber when no merge can be offered (another branch is checked out, the lander is landing into the clone, upstream has no default branch) or the last fetch failed.

## Actions

- `state` — the clone against upstream from the last check; never fetches.
- `check` — fetch upstream now under the lock, then the state.
- `merge` (user-only) — while `merge` is offered (behind, nothing refuses, the clone is the project this Ultimate serves), sends @ultimate an input asking for a coordinator branch that merges `upstream/<branch>` with the project's `merge-upstream` skill, deduplicated per `<head>..<upstream head>`; returns @ultimate's conversation id, which the popover opens.

## Setup

```bash
git remote add upstream https://github.com/HazAT/ultimate.git
git fetch upstream && git remote set-head upstream --auto
```
