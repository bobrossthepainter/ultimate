Keeps a branch coordinator's Claude prompt cache warm while the branch waits, and compacts it before the cache runs cold, so its next turn does not write the whole context again. Off by default; the `cache` chip in a branch's status line has both switches.

## Why

A branch waits for long stretches: on the user, a subagent, the lander. After an hour without a request its one-hour cache (Claude Code, or the Anthropic API under `PI_CACHE_RETENTION=long`) is gone, and the next turn writes the whole context again at twice the input price. A ping reads it at a tenth; a compaction shrinks what the next turn writes to the summary and the recent turns kept verbatim.

## How

- Applies to open branch coordinators (label `coordinator`, top-level, not concluded) on a provider with an hour-long cache. Workers, scouts and reviewers are subagents: short-lived, compacted inside their run.
- A timer outside the task scheduler looks once a minute; nothing happens while Ultimate is paused or a branch has a run. A step is due when the branch's last cache request (its newest cached answer, or the last successful ping) is 55–60 minutes old.
- **Keep warm** pings while the branch saw any input in the last 8 hours (the user's, a subagent or lander report, a message), as `keep-warm` pings @ultimate: the branch's next context plus one `ok` line, no `sessionId`, nothing in the transcript, usage added to the branch. A failed ping blocks pings until the branch's next request. At most `maxWarm` branches are kept warm, the most recently active first.
- **Compact before cold** starts a manual compaction instead, when the branch is not kept warm (off, its 8 hours over, over the limit or after a failed ping), its context has at least `minCompactTokens`, and it was not compacted since its last request. With both on, the branch is pinged while active and compacted once its window ends.
- Its compaction's summary reads the cache: this extension's `beforeCompact` hook (ordered before lineage's) sends the branch's next context plus a request for the summary, so the summary costs a cache read instead of the whole context as fresh input. Its usage counts on the branch. If that request fails, lineage's summarizer writes the summary. The summary is memoised, and the compaction's admission commits with its record, so a restart neither repeats it nor starts a second one.

## Settings

`branchCache` in the project's `.ultimate/settings.json`, all optional:

```json
{
  "branchCache": {
    "maxWarm": 5,
    "minCompactTokens": 150000,
    "default": { "warm": false, "compact": false }
  }
}
```

`default` applies to branches whose switches were never set.

## State and actions

- `branch-cache.state` on each branch: `{ warm?, compact?, last?, pings?, compaction? }`.
- `state { id }` → the switches, the cache's last request, context size, the next step or why none, the last ping and compaction.
- `set { id, warm?, compact? }`, user-only: pings and summaries spend the user's plan.
