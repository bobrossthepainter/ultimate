The Architecture tab: an architect agent draws what a branch changes architecturally as a few Mermaid diagrams, one
version per run, and the user comments on their parts; the comments go to the branch's coordinator as input.

Off by default; enable `architect` in `extensions.enable`. A fork-only extension (`.ultimate/FORK.md`).

## Drawing

The architect is `agents/architect.md` (read-only: `read`, `bash`, `architecture_publish`; the `review` family). It
ships with the extension, so the definition exists only while the extension is on. Each branch gets one architect
conversation, a child of the branch (owned by an `architect.anchor` task, so the sidebar shows it under the branch),
made on its first run and reused after, its cwd the branch's worktree (the project checkout once that is gone).

A run starts only when the user asks: **Draw**, in the surface or ⌘K **Draw architecture** (the `draw` action). It
returns at once; a Draw while the architect still draws starts nothing. No agent has a tool to draw.

Its brief names the branch, its worktree and target (the architect reads `git diff <target>...HEAD` and uncommitted
work itself), the committed changed files (`git diff --stat`, which asks for implementation views), the branch's plan, its coordinator's latest answer, and the previous version as JSON, so diagram and
part IDs stay the same across versions.

## Versions

`architecture_publish { title, summary, diagrams }` appends a version to the branch's `architect.versions` document
(on the branch conversation) and records the branch in `architect.index` on the root, which the surface's picker lists.
Only a conversation `draw` made can publish. A version is:

```ts
{ version, at, architect, title, summary, code?: { spec?, changed, ref },
  diagrams: [{ id, title, mermaid, notes, parts, level, useCase?, code }] }
```

`id` is a slug kept across versions; `mermaid` is the source with stable node IDs and `:::added`, `:::changed` or
`:::removed` on changed parts (the surface supplies their `classDef`s); `parts` maps node or participant IDs to what
each is. No diagrams means nothing architectural changed. At most 6 diagrams of 20,000 characters each. The format is
the Mermaid source plus that part map, so another renderer can take it over later.

`level` is `overview` (the default: components, flows, stored shapes) or `implementation`: the call path of one
`useCase` through the actual classes, interfaces and functions, once the branch has code. `code` maps part IDs (nodes,
participants, and edges by their explicit `e1@-->` ID) to `{ source?: { path, symbol?, line? }, status, evidence }`:
`implemented` (needs a source) or `proposed`, `static` (read) or `runtime` (seen in a trace). Publishing checks that
every source path is a file committed on the branch (`git ls-tree HEAD`; uncommitted code is drawn proposed) and records the version's
`code`: the Review spec of the branch's change (`branch:<name>`, while it has a worktree), the paths it changes, and the
branch the rest is on.

## The surface

**Architecture** (`surface.tsx`, lazy-loaded with Mermaid; ⌘K **Open Architecture**) shows one branch at a time: the
shown conversation (or the branch its architect draws) when it has versions, else the latest. The header picks the
branch, the version and a version to **compare** with; **Draw** asks for a new one. The left column lists the version's
diagrams with their change dots and pending comments, the implementation views by use case under an **implementation**
heading, and the chosen diagram's notes and drafts; on a phone they are a row of tabs. A part with `code` shows its
source above its comment: a changed file opens in Review at that line in the branch's change, any other on GitHub at
`ref`; with the part's status and evidence. Proposed parts are drawn dashed and faded, and the legend adds them. A diagram renders through `mermaid/ui.tsx` with `classDef added/changed/removed` from the theme's
`--diff-add`, `--warning` and `--diff-del` (unless its source defines them), under a legend. Compare flips the same
diagram (by id) between the two versions in place, or shows both side by side (not on a phone). A version without
diagrams reads "Nothing architectural changed" with its summary. A source Mermaid cannot parse shows its error and
source.

**Discuss** opens the architecture chat (`chat.tsx`) beside the diagram, which stays visible and clickable; on a phone
it covers the diagram until closed. The first open makes the chat (`chat` action); its header names the version it
was opened at, and once a newer version exists it offers **New chat on vN** (`fresh`). Its suggested comments land in
the same pending list, marked **chat** with a dashed edge and an outlined marker on their part; the user edits,
deletes and sends them like their own.

## Feedback

Clicking a node, an edge or (in a sequence diagram) a participant opens a comment on it by its ID; the diagram's title
takes a comment on the whole diagram. `parts.tsx` maps a click back to the source ID, verified on Mermaid 12.3.0:
flowchart, class, ER and state nodes by their group's id (`<svg>-flowchart-<id>-<n>`, `-classId-`, `-entity-`,
`-state-`), edges by `data-id` (`L_<a>_<b>_<n>`, `id_<a>_<b>_<n>`), participants by the `name` on their boxes and stick
figures. A part with a draft carries a marker, and clicking it again edits that draft. Drafts live on the branch
(`architect.drafts`, changed with the `edit` action) per version, so the chat's suggestions and the user's own share
one list. **Send** posts the `send` action: one `architect.comments` input into the recipient (the branch's coordinator unless the **to** picker says
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
