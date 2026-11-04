Runs programs where a working directory lives. Every caller names the directory first; the service picks the target
whose root is the longest one containing it, and runs there. Without another protocol everything runs on this machine,
exactly as `lib/exec.ts`, `lib/process-group.ts` and Pi's `NodeExecutionEnv` do.

The `Exec` service (`api.ts`), which core extensions `need`:

- `resolve(cwd)`: the target owning `cwd`, else `local`.
- `run(cwd, file, args, options)`: to its end, like `execFile`; resolves `{ stdout, stderr }`.
- `start(cwd, file, args, options)`: a long-running process group, streamed and stoppable, like `spawnGroup`.
- `git(cwd, ...args)`: trimmed stdout, like `git` from `lib/git.ts`.
- `env(cwd)`: Pi's execution environment. The server asks for it (`host.executionEnv`), so the agent's `bash`, `read`,
  `write` and `edit` run where their conversation's directory lives.

Another extension sends directories elsewhere by providing the `exec.protocol` point: a protocol (`run`, `start`,
`env`, each given the resolved target) and `targets()`, each `{ protocol, id, root, files, config }`. `files: 'shared'`
means this machine sees the target's files at the same paths (a container sharing a volume); `'remote'` means only the
target does. `run`, `start` and `git` read the targets at every call; the harness keeps the environment it built for a
directory until it closes, so register a target before an agent works in it.

Work in a project or worktree goes through the service. Ultimate's own host-local work does not and keeps
`lib/exec.ts`: Caddy, Tailscale, the updater, extension actions' `ctx.exec`, the system snapshot, automation scripts and
the editor launcher, and previews (`instance`): a preview is Ultimate's own server, listening on `127.0.0.1` for this
host, and its cleanup runs at shutdown after services are gone.
