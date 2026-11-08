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

## The surface

**Architecture** (`surface.tsx`, lazy-loaded with Mermaid; ⌘K **Open Architecture**) shows one branch at a time: the
shown conversation (or the branch its architect draws) when it has versions, else the latest. The header picks the
branch, the version and a version to **compare** with; **Draw** asks for a new one. The left column lists the version's
diagrams with their change dots and pending comments, and the chosen diagram's notes and drafts; on a phone they are a
row of tabs. A diagram renders through `mermaid/ui.tsx` with `classDef added/changed/removed` from the theme's
`--diff-add`, `--warning` and `--diff-del` (unless its source defines them), under a legend. Compare flips the same
diagram (by id) between the two versions in place, or shows both side by side (not on a phone). A version without
diagrams reads "Nothing architectural changed" with its summary. A source Mermaid cannot parse shows its error and
source.

## Feedback

Clicking a node, an edge or (in a sequence diagram) a participant opens a comment on it by its ID; the diagram's title
takes a comment on the whole diagram. `parts.tsx` maps a click back to the source ID, verified on Mermaid 12.3.0:
flowchart, class, ER and state nodes by their group's id (`<svg>-flowchart-<id>-<n>`, `-classId-`, `-entity-`,
`-state-`), edges by `data-id` (`L_<a>_<b>_<n>`, `id_<a>_<b>_<n>`), participants by the `name` on their boxes and stick
figures. A part with a draft carries a marker, and clicking it again edits that draft. Drafts are durable UI state per
branch and version. **Send** posts the `send` action: one `architect.comments` input into the recipient (the branch's coordinator unless the **to** picker says
otherwise), which wakes or steers it like a typed message. The model reads:

```text
Architecture feedback on v2 of #42's diagrams (1 comment)

**Components** · `surface` (node: Surface)
Why a tab?
```

The recipient's transcript shows it as a card on the user's side (`card.tsx`); each comment's chip opens the surface at
that version and diagram, the part marked.

## Actions (`refs.ts`)

- `draw { conversation }` → `{ architect, started }`: the conversation may be the branch or its architect.
- `send { conversation, branch, version, comments, note? }` (user only) → `{ conversation }`. At most 50 comments of
  at most 4,000 characters; throws on an unknown conversation or version.
