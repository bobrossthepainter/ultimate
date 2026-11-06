Search the public web with Brave Search through `web_search`. It needs `secrets` on as well, and replaces `parallel`: both provide `web_search`, so turn on only one (the second fails to load with `web_search is already provided by …`).

Set `BRAVE_API_KEY` in the Secrets panel (⌘K → Secrets), from https://api-dashboard.search.brave.com/app/keys. The Search plan costs $5 per 1,000 requests and includes $5 of free credit every month (about 1,000 searches), up to 50 requests per second; signing up needs a credit card even for the free credit. The user-global secret store takes priority over `BRAVE_API_KEY` in the server environment. Missing credentials produce a tool error and one process-local notice, never an in-chat credential form.

It calls Brave's [LLM Context](https://api-dashboard.search.brave.com/documentation/services/llm-context) endpoint (`GET /res/v1/llm/context`), which returns each result with the passages of its page that answer the query, already extracted. `maxResults` sets `count` and `maximum_number_of_urls`, `afterDate` becomes a `freshness` range ending today, and `country` passes through. Brave has no endpoint that reads a named URL, so there is no `web_fetch`: use `site:` in the query or curl.

Calls are read-only and replay-safe, with a 120-second timeout and cancellation. Text output is capped at 50 KiB / 2000 lines; structured details carry results with their dates and excerpts. `ULTIMATE_BRAVE_TEST_URL` overrides the API base only for local fake-server tests; never set it in production.

## UI

`web_search` renders from its `details` with the card copied from `parallel`, collapsed while it succeeds: the query, the top three domains, and `n results`; expanded, each result's title as a link, its domain, date, and a three-line excerpt. A failed call opens itself to show the error with its HTTP status and reference. For a missing or rejected key, Add key (Replace key) beside the header opens the Secrets panel at `BRAVE_API_KEY`; while `secrets` is off, Turn on secrets opens the Extensions panel.
