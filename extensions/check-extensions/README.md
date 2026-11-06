Checks extension files in any project's `.ultimate/extensions/` with Ultimate's own format, lint and type rules through the `check_extensions` tool.

## Tool

`check_extensions { paths, fix? }` takes absolute files or folders under a `.ultimate/extensions/` folder (any project,
`~/.ultimate/extensions/` included) or the clone's `extensions/`; relative paths and paths elsewhere are refused. It
runs the clone's `node_modules/.bin/vp` from this process, never a shell, with a 120-second timeout:

1. With `fix: true`, `vp fmt --write` on the paths.
2. `vp fmt --list-different`: files whose format differs.
3. `vp lint` with the clone's `vite.config.ts`: its rules, type-aware rules and TypeScript diagnostics. Rules the clone
   scopes to its own paths (`extensions/**`) do not apply outside it; `**/*` and `**/.ultimate/extensions/**` rules do.

The output has one section per failing check (format, lint, types) with `file:line:column` relative to the extension
root, or one "All clean" line. `details` carry `{ roots, files, fixed, format, lint, types }` counts.

It runs where Ultimate runs, since extension code always loads from the host's filesystem: the same locally, in a pod,
and for a project over SSH.

## Type-checking outside the clone

A project extension imports what built-ins import (`@/sdk`, `react`, `../../../server/actions.ts` for types), which
resolve only inside the clone. For each extension root and kind, the tool stages a temporary folder (removed after the
run) with `.ultimate/extensions` linked to the root, `node_modules` linked to the clone's, a `package.json` with
`"type": "module"`, and a `tsconfig.json` extending the clone's `tsconfig.json` (`.ts`) or `tsconfig.web.json`
(`.tsx`) with `rootDirs: [folder, clone]`, so `../../../server/*` and `@/*` resolve into the clone. Lint runs on the
staged paths and reports the original ones. Files in the clone itself are checked in place.

## UI

The call renders as a tool card: the paths, a count per failing check (`1 format issue`, `2 lint issues`,
`1 type error`) or `clean`, and the file count; expanded, the text output.
