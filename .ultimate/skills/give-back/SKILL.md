---
name: give-back
description: Prepare one fork divergence marked "candidate" in .ultimate/FORK.md as a pull request to upstream (HazAT/ultimate) - port only that concept onto a clean branch off upstream main, make it generic, run the checks, draft the title and body, and open it only after the user's go. Use when asked to give back, upstream or contribute a concept from this fork.
---

# Give a fork concept back upstream

This repository is a fork: `origin` is the fork, `upstream` is HazAT/ultimate. `.ultimate/FORK.md` lists each local
divergence as a `###` section with the paths it touches (`Touches`), `Why`, and its `Upstream` status (`local-only`,
`candidate`, `given back as PR #N`). This skill turns one `candidate` section into one pull request. It is the sender's side of
`.ultimate/skills/assess-outside-pr`: the PR should pass that checklist before upstream reads it.

`CONTRIBUTING.md` is the policy: one pull request per idea, check the open ones first, features are titled
"Feature: …" and usually stay open as references, agent names go in backticks. Opening a pull request on another
repository is outside the standing push permission: nothing leaves this machine before the user's explicit go.

## 1. Pick the concept

Take one section whose `Upstream` field is `candidate`; its heading names it, its `Touches` field scopes it. Choose a short slug for it
(`supervisor-network-flags`). Then:

```bash
git remote get-url upstream || git remote add upstream https://github.com/HazAT/ultimate.git
git fetch upstream origin
gh pr list --repo HazAT/ultimate --state all --search "<keywords>"
```

If an open or merged pull request already covers the idea, stop and report it. If the concept only makes sense with
another candidate (it calls code that section adds), say so and propose giving them back together or in order.

## 2. A clean worktree off upstream main

```bash
git worktree add <home>/give-back/<slug> -b give-back/<slug> upstream/main
cd <home>/give-back/<slug> && pnpm install --frozen-lockfile --prefer-offline
```

`<home>` is the Ultimate home (`~/.ultimate`). This is a plain git worktree, not a lineage workspace: never
`workspace submit` it, since the lander would merge upstream-based work into the fork's main and push it to `origin`.

## 3. Extract by path, not by commit

The fork's commits often bundle several concepts, so cherry-picking carries the others along. Diff the fork against
upstream over the section's paths instead, and rebuild the concept as one fresh commit:

```bash
git diff upstream/main origin/main -- <paths from Touches> > /tmp/give-back-<slug>.diff
git apply -3 /tmp/give-back-<slug>.diff
git reset -q        # unstage, then pick
git add -p          # keep only this concept's hunks where a file mixes concepts
git add <new files of this concept>
git checkout -- . && git clean -n   # drop the rest; review, then clean -f
```

Read what is left: every hunk belongs to this concept, and nothing it needs is missing (an import, a setting's
default, its docs, its test). Upstream may have moved the surrounding code; resolve conflicts towards upstream's
current shape.

## 4. Make it generic

Upstream is public and shared by strangers. Before committing:

```bash
me="$(gh api user -q .login)|$(git config user.name)|$(git config user.email)|$(hostname)|$HOME|$(git worktree list --porcelain | head -1 | cut -d' ' -f2)"
git diff --cached upstream/main | grep -niE "$me|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|@[a-z0-9-]+\.[a-z]{2,}|\.local\b|\.ts\.net"
```

Also grep for the user's company, products and private repository names if the project memory names any.

Every hit is either removed or replaced: a generic name ("the user", `my-app`, `example.com`, `192.0.2.1`), a
documented setting with a neutral default instead of a machine-specific value, no `.ultimate/` personal config, no
model choices only this machine has. Follow `AGENTS.md` conventions (generic examples, erasable TypeScript, a
justified dependency in its commit message). Commit once, describing the concept, without the
`Ultimate-Conversation` trailer (it points into this machine's history):

```bash
git commit -m "<Title>" -m "<what and why>"
```

## 5. Verify as upstream would

```bash
pnpm check && pnpm test && pnpm test:e2e
```

Then run `assess-outside-pr` step 1 on your own diff: new dependencies or lifecycle scripts, network calls, weakened
checks, skipped tests, raised timeouts, `.github/` changes. Classify it under `CONTRIBUTING.md`: a clear-cut core fix
or improvement, or a feature ("Feature: …").

## 6. Draft and ask

Write the title and a body in `.github/pull_request_template.md`'s shape (what and why, how it was verified, what it
touches). No real names, machines or addresses; agent names in backticks. Ask the user with one card, showing the
diff stat, the full diff (`git diff upstream/main`), the check results and the draft. One go covers both pushing the
branch to the fork and opening the pull request.

## 7. After the go

```bash
git fetch upstream && git rebase upstream/main   # only if upstream moved; rerun step 5 after
git push origin give-back/<slug>
gh pr create --repo HazAT/ultimate --head "$(gh api user -q .login):give-back/<slug>" --base main \
  --title "<title>" --body-file /tmp/give-back-<slug>.md
```

A fork contributor usually cannot set labels; upstream labels features itself. Never comment, close or retitle
afterwards without the user's OK.

## 8. Record it

In your own lineage workspace (not the give-back worktree), set the section's `Upstream`
field to `given back as PR #N` with the link, commit and `workspace submit` as usual. Remove the give-back worktree
(`git worktree remove <home>/give-back/<slug>`) and keep the branch for follow-up pushes to the pull request.
