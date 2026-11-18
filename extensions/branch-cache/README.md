Keeps a branch coordinator's prompt cache warm while the branch waits, and can compact it before the cache runs cold, so its next turn does not write the whole context again. Keeping warm is on by default; the `branch` chip in a branch's status line (flame orange while warm, blue when cold, grey while off) has the branch's switches and its model's cache policy.

## Why

A branch waits for long stretches: on the user, a subagent, the lander, or inside its own run on a long command. Once its cache expires, the next turn writes the whole context again: at 1.25 times the input price after a five-minute cache, twice after a one-hour one. A ping reads it at a tenth of the input price; a compaction shrinks what the next turn writes to the summary and the recent turns kept verbatim.

Measured on GitHub Copilot (November 2026): Claude Opus 5.5 keeps the cache for 5 minutes. A 240k context costs $1.20 to write again and $0.05 to ping; over 20 days of coordinators, pinging for 30 minutes after the last request cut the cache cost from $129 to $70. Asking for one-hour caches instead costs twice the write price.

## How

It follows pi's own cache warmer (`CacheWarmer` in pi-coding-agent, policy in pi-ai's `cache-warming`), which Pi Durable does not run:

- Applies to open branch coordinators (label `coordinator`, top-level, not concluded). Workers, scouts and reviewers are subagents: short-lived, compacted inside their run.
- **Cache lifetime** comes from the model's `promptCache` metadata, as pi-ai's `getPromptCacheTtlMs` reads it (`long` under `PI_CACHE_RETENTION=long`, else `short`). Claude Code models, whose catalog has none, always write one-hour caches. A model without a known lifetime is not warmed. Models that pi-ai does not describe, such as Claude on Copilot, get one through `modelOverrides` in pi's `~/.pi/agent/models.json`:

  ```json
  {
    "providers": {
      "github-copilot": {
        "modelOverrides": {
          "claude-opus-5.5": { "promptCache": { "short": 300, "long": 3600 } }
        }
      }
    }
  }
  ```

- **Each answer starts a warming run** from the request that wrote the cache. A timer per branch fires at 90 % of the lifetime after the last request on the cache (pi-ai's `getCacheWarmingDelayMs`: 4.5 minutes on a five-minute cache, 54 on an hour), and again after each ping. A timer that fires after half the remaining margin is skipped: a late refresh writes the cache at full price. A new answer, a compaction or a model switch ends the run.
- **A ping re-sends the last real request** as the provider received it (captured by `beforeProviderRequest`), with its output capped at one token and no retries (`getCacheWarmingRequestOptions`): it reads the whole cache and writes nothing. Models whose requests cannot be replayed unchanged (budget-based thinking, `isCacheWarmingReplayable`) are not warmed. Claude Code requests are not visible to that hook, so their ping is the branch's next context plus one `ok` line. Usage counts on the branch; nothing goes in the transcript. A failed ping ends the run.
- **How long:** while the branch has a run (a long command, a foreground subagent, a wait), up to an hour after its request (pi's `CACHE_WARMING_MAX_AGE_MS`); when it is idle, `warmMinutes` after its last request, 30 by default (pi's `CACHE_WARMING_MAX_IDLE_AGE_MS`). An idle hour-long cache (Claude Code) is therefore not pinged by default, since its ping is due at 54 minutes; earlier versions kept it warm for 8 hours, which `warmMinutes: 480` for `claude-code/*` restores. At most `maxWarm` branches are kept warm, those with the most recent requests first.
- **Compact before cold** starts a manual compaction when an idle branch's window is over, its context has at least `minCompactTokens`, and it was not compacted since its last request. On a five-minute cache it waits for the warm window, so it compacts only after keeping warm ended; with keeping warm off it never compacts a five-minute cache.
- Its compaction's summary reads the cache: this extension's `beforeCompact` hook (ordered before lineage's) sends the branch's next context plus a request for the summary. If that request fails, lineage's summarizer writes the summary. The summary is memoised, and the compaction's admission commits with its record, so a restart neither repeats it nor starts a second one.
- Warming runs live in the process: a restart ends them, and each branch's next answer starts a new one. Nothing happens while Ultimate is paused.

## Settings

`branchCache` in `~/.ultimate/settings.json` (every project on this machine) or the project's `.ultimate/settings.json` (wins), all optional. `models` keys are `provider/model` or `provider/*`; an exact key wins over the provider's.

```json
{
  "branchCache": {
    "maxWarm": 5,
    "models": {
      "github-copilot/*": { "warm": true, "compact": false },
      "github-copilot/claude-opus-5.5": { "warmMinutes": 30, "minCompactTokens": 150000 }
    }
  }
}
```

Defaults: `warm` on, `compact` off, `warmMinutes` 30, `minCompactTokens` 150000. A branch's own switches override `warm` and `compact`. The chip's popover shows where each value comes from (`branch`, `model`, `default`, `yours`, `project`) and edits `warmMinutes` and `minCompactTokens` for the branch's model in the user's settings; a value set by the project is shown, not edited.

## State and actions

- `branch-cache.state` on each branch: `{ warm?, compact?, last?, pings?, compaction? }`.
- `state { id }` → the switches, the model with its cache lifetime, ping time and policy, the last request on the cache, context size, the next step or why none, the last ping and compaction.
- `set { id, warm?, compact? }` and `set-model { provider, model, warmMinutes?, minCompactTokens? }` (`null` removes a value), user-only: pings and summaries spend the user's plan.
