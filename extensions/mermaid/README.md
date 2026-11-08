Draws `mermaid` code blocks in messages as their diagrams, in Ultimate's theme colours.

A `codeBlocks` renderer for the `mermaid` language. While the fence still streams it shows the highlighted source;
once complete it draws the diagram with [Mermaid](https://mermaid.js.org) (`securityLevel: 'strict'`), which
`diagram.tsx` loads with the first diagram shown, not with the app. Colours and font come from the theme tokens
(`--card`, `--brand`, `--foreground`, `--muted-foreground`, `--border`, `--terminal`), converted to hex because
Mermaid computes shades from them; a theme switch redraws. Hover shows a button to switch between diagram and source.
A diagram Mermaid cannot parse shows its source with the parse error's first line under it.
