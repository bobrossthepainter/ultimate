The Usage surface shows what this instance's model calls cost and, for every other Ultimate it reaches, theirs: over time, by cost type, cache rebuilds, by role, by model and by branch, as list-price estimates.

## What it counts

- **Calls** are the stored `pi.assistant` responses of every conversation, with their provider, model, time, tokens
  and Pi's cost by kind (uncached input, output, cache reads, cache writes). A branch's scan starts at its fork point,
  so history it inherits is counted once, in its parent.
- **Undated** is the rest of each conversation's `pi.usage`: tool usage, titles and summaries, keep-warm pings. They
  have no entry, so they have no day, role or branch; the report adds them as one line so the totals match the status
  bar's spend.
- **Rebuilds** are the calls `cacheBusts` in `lib/context-usage.ts` marks, the same ones the transcript's "cache
  rebuilt" line shows, by cause: `expired` (the gap since the previous call outlived the cache), `system` (the system
  prompt changed), `model` (a model switch) and `prefix` (earlier context changed). A rebuild's cost is what it sent
  fresh: uncached input and cache writes.
- **Roles** come from `subagents.started`: a standing agent is `@<name>`, a branch is `coordinator`, a child is its
  definition (`worker`, `reviewer` for every reviewer-*, `dream` for the dream passes, `adhoc` for one made on the
  fly). A conversation without the event falls back to its label.
- **Branches** group each conversation under the topmost one that is a branch or standing agent, following owners.

Costs are Pi's list prices (`totalFromProvider: false`). A provider reached through a plan (claude-code, Copilot, Codex
subscriptions) is billed by the plan, not per token: its rows carry `sub` and its dollars read as what the tokens would
cost at list price.

## How it is computed

In memory, nothing stored: when the server opens, the server facet reads every conversation's entries and `pi.usage`
once, then follows commits (new entries, `pi.usage` changes). A restart builds it again, in well under a second for
tens of thousands of entries.

## Actions

- `report { since?, until? }` → this instance's `Report` (`refs.ts`) over that range in ms, all time without them.
- `spokes` → `{ spokes, errors }`: the other instances `lib/remote.ts` reaches (`reachable`), once per address:
  projects running on this machine, the user's `remotes` (which win over the register for the same project and
  machine), and the cloud register's projects on other machines with an address.
- `spoke { url, since?, until? }`, a listed spoke's `url` → that instance's `report`. An instance without this extension
  answers with its `pi.usage` totals by model instead (`fallback: true`, no days, roles, branches or rebuilds). One
  that cannot be reached throws, so it never shows as $0.

## UI

⌘K **Open Usage**. The header picks the scope (this instance, one spoke, or all reachable together), the range (7 d,
30 d, all) and dollars or tokens. Below: the total with its estimate label, daily bars stacked by cost type, the cost
type shares, rebuilds by cause and by role, then role, model and branch tables; a branch row on this instance opens it.
