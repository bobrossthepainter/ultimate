---
name: merge-upstream
description: Merge new upstream (HazAT/ultimate) commits into this fork's main on a coordinator branch, keep the fork's divergences, and record in .ultimate/FORK.md what the merge changed about them. Use for an "Update with @ultimate" input naming upstream/main, or when asked to merge or pull upstream.
---

# Merge upstream

This repository is a fork: `origin` is the fork, `upstream` is the repository it came from. The `upstream-sync`
extension compares main with `upstream/main` (the `↓ N upstream` item), and its **Update with @ultimate** button asks
for this merge.

## Setup, once per clone

When `git remote get-url upstream` fails, add it and set its default branch; it lives in git config, not in a commit:

```bash
git remote add upstream https://github.com/HazAT/ultimate.git
git fetch upstream && git remote set-head upstream --auto
```

## The merge

1. In the branch worktree: `git fetch upstream`, then `git merge upstream/main`. Always a normal merge commit, never a
   rebase, reset, squash or force push: the fork's history and upstream's stay intact, so the next merge is cheap.
2. Read `.ultimate/FORK.md` first. Each divergence it lists (one `###` section, with its paths under `Touches`) is
   intended: in a conflict on one of its paths, keep the
   fork's side and take upstream's other changes around it.
3. Resolve on your own what is mechanical (both sides touching neighbouring lines, an import list, a renamed caller).
   Bring the rest to @ultimate as decisions: upstream reworked something the fork changed, or a divergence upstream
   now covers in its own way (it may be dropped).
4. Update `.ultimate/FORK.md` for every divergence the merge touched: changed (edit its section's fields), now
   upstream (remove its section), or newly needed (add a section at the end). Commit it with the merge.
5. Run `pnpm install --frozen-lockfile` in the worktree when the lockfile changed, then `pnpm check` and the tests
   covering the conflicts. `workspace submit`; the lander runs everything and pushes to origin.

## After landing

The update extension installs packages when the landing changed `pnpm-lock.yaml`, and the status line asks for a
restart when `server/`, `shared/` or packages changed (`bin/` needs a human `pnpm start`). Say which in the report;
never restart on your own.
