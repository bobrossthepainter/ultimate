Runs programs where a working directory lives. Every caller names the directory first; the service picks the target
whose root is the longest one containing it, and runs there. Without another protocol everything runs on this machine,
exactly as `lib/exec.ts`, `lib/process-group.ts` and Pi's `NodeExecutionEnv` do.

The `Exec` service (`api.ts`), which core extensions `need`:

- `resolve(cwd)`: the target owning `cwd`, else `local`.
- `run(cwd, file, args, options)`: to its end, like `execFile`; resolves `{ stdout, stderr }`. The server runs extension
  actions' `ctx.exec` with it (`host.execution`), with the action limits: 30 s, 1 MiB, the action's abort signal.
- `start(cwd, file, args, options)`: a long-running process group, streamed and stoppable, like `spawnGroup`.
- `git(cwd, ...args)`: trimmed stdout, like `git` from `lib/git.ts`.
- `env(cwd)`: Pi's execution environment. The server asks for it (`host.execution`), so the agent's `bash`, `read`,
  `write` and `edit` run where their conversation's directory lives.

- `describe(cwd)`: the owning target as `{ protocol, id, root, description }`, the description being the protocol's
  one line for people (`local Node`; never a secret or a key's path). The browser reads it through the `target` action
  (`refs.ts`, `{ cwd }`); the Info panel's Execution section shows it.

Another extension sends directories elsewhere by providing the `exec.protocol` point: a protocol (`run`, `start`,
`env`, `describe`, each given the resolved target) and `targets()`, each `{ protocol, id, root, files, config }`. `files: 'shared'`
means this machine sees the target's files at the same paths (a container sharing a volume); `'remote'` means only the
target does. `run`, `start` and `git` read the targets at every call; the harness keeps the environment it built for a
directory until it closes, so register a target before an agent works in it.

Work in a project or worktree goes through the service. Ultimate's own host-local work does not and keeps
`lib/exec.ts`: Caddy, Tailscale, the updater, the system snapshot, automation scripts and the editor launcher, and
previews (`instance`): a preview is Ultimate's own server, listening on `127.0.0.1` for this host, and its cleanup runs
at shutdown after services are gone. Lint keeps every other extension, a project's own included, from spawning past
the service (`ultimate/no-unrouted-exec`); the host-local ones are listed by name in `vite.config.ts`.
