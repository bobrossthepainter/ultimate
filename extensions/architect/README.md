The Architecture tab: an architect agent draws what a branch changes architecturally as a few Mermaid diagrams, one
version per run, and the user comments on their parts; the comments go to the branch's coordinator as input.

Off by default; enable `architect` in `extensions.enable`. A fork-only extension (`.ultimate/FORK.md`).

## Drawing

The architect is `agents/architect.md` (read-only: `read`, `bash`, `architecture_publish`; the `review` family). It
ships with the extension, so the definition exists only while the extension is on. Each branch gets one architect
conversation, a child of the branch (owned by an `architect.anchor` task, so the sidebar shows it under the branch),
made on its first run and reused after, its cwd the branch's worktree (the project checkout once that is gone).

A run starts in one of two ways:

- **Draw**, in the surface or ⌘K **Draw architecture**: the `draw` action. It returns at once; a Draw while the
  architect still draws starts nothing.
- **`draw_architecture`**, a deferred tool the coordinator definition adds (`.ultimate/agents/coordinator.md`): once
  the plan is set and again before `workspace submit`. It waits for the architect and returns its summary.

Its brief names the branch, its worktree and target (the architect reads `git diff <target>...HEAD` and uncommitted
work itself), the branch's plan, its coordinator's latest answer, and the previous version as JSON, so diagram and
part IDs stay the same across versions.

## Versions

`architecture_publish { title, summary, diagrams }` appends a version to the branch's `architect.versions` document
(on the branch conversation) and records the branch in `architect.index` on the root, which the surface's picker lists.
Only a conversation `draw` made can publish. A version is:

```ts
{ version, at, architect, title, summary, diagrams: [{ id, title, mermaid, notes, parts }] }
```

`id` is a slug kept across versions; `mermaid` is the source with stable node IDs and `:::added`, `:::changed` or
`:::removed` on changed parts (the surface supplies their `classDef`s); `parts` maps node or participant IDs to what
each is. No diagrams means nothing architectural changed. At most 6 diagrams of 20,000 characters each. The format is
the Mermaid source plus that part map, so another renderer can take it over later.

## Feedback

Clicking a node, an edge or (in a sequence diagram) a participant opens a comment on it by its ID; the diagram's title
takes a comment on the whole diagram. Drafts are durable UI state per branch and version. **Send** posts the `send`
action: one `architect.comments` input into the recipient (the branch's coordinator unless the **to** picker says
otherwise), which wakes or steers it like a typed message. The model reads:

```text
Architecture feedback on v2 of #42's diagrams (1 comment)

**Components** · `surface` (node: Surface)
Why a tab?
```

The recipient's transcript shows it as a card on the user's side.

## Actions (`refs.ts`)

- `draw { conversation }` → `{ architect, started }`: the conversation may be the branch or its architect.
- `send { conversation, branch, version, comments, note? }` (user only) → `{ conversation }`. At most 50 comments of
  at most 4,000 characters; throws on an unknown conversation or version.
