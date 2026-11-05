Tells a process manager whether this instance may stop now and when it must run again, for one that stops idle
instances and starts them on demand (a Kubernetes operator scaling a StatefulSet to zero). Off by default: enable it
with `"extensions": { "enable": ["lifecycle"] }`.

## Action

`POST /api/extensions/lifecycle/actions/state` with `{ "args": {} }` (an `Origin` the server admits) returns:

```json
{
  "result": {
    "now": 1793890000000,
    "active": false,
    "busy": [],
    "scripts": [],
    "inputAt": 1793880000000,
    "nextWake": 1793893600000,
    "wakes": [{ "at": 1793893600000, "reason": "A3 every 1h" }]
  }
}
```

- `now`: this machine's clock (ms), so the caller can correct for skew. Every time is on it.
- `active`: Pi's `harness.wake().active`: some task runs or can run now, background ones (dream passes, deliveries,
  summaries) included.
- `busy`: conversations with non-background work, as the sidebar shows them; a running landing counts.
- `scripts`: automations whose script process is alive. Those are processes, not tasks: they die with the instance and
  restart when it starts again.
- `inputAt`: the user's latest input in any conversation, from the newest `user.input` event; absent before the first.
- `wakes`: Pi's earliest sleeping task (`harness.wake().at`: a retry backoff, a schedule's sleep), plus what automations
  report (`AutomationsService.wakes`): each enabled schedule's next fire, and each context condition with `idleFor`
  that is over its threshold, at the end of the user's pause or its cooldown. A condition under its threshold has no
  wake: its measurement changes only while something runs. A time already past is reported as `now`.
- `nextWake`: the earliest of `wakes`.

The instance may stop when nothing is `active`, `busy` or in `scripts`; it must run again at `nextWake` or on the next
request. Stopping loses nothing: durable work resumes when it starts again. Without the automations extension, `wakes`
holds only Pi's sleeps and `scripts` is empty.
