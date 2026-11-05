Runs the commands of configured directory roots on SSH targets: the `ssh` protocol of the exec service's
`exec.protocol` point (`extensions/exec/README.md`). Made for a toolchain container next to Ultimate that shares its
files at the same paths, as in a pod with a shared volume: project work, worktree setup, the lander's checks and the
agent's `bash` run in the container, while `read`, `write` and `edit` stay on this machine's view of the same files.
Off by default.

## Settings

Only `~/.ultimate/settings.json` names targets; a project's settings cannot send this machine's commands anywhere:

```json
{
  "extensions": { "enable": ["ssh-exec"] },
  "ssh-exec": {
    "targets": [
      {
        "id": "toolchain",
        "root": "/workspace",
        "files": "shared",
        "host": "127.0.0.1",
        "port": 2222,
        "user": "dev",
        "identityFile": "/home/node/.ssh/exec_ed25519",
        "knownHostsFile": "/home/node/.ssh/exec_known_hosts"
      }
    ]
  }
}
```

- Every directory at or below `root` runs on the target; everything else runs here. Put Ultimate's home under the root
  (`ULTIMATE_HOME`) when worktrees and the lander's checkout should run there too.
- `files` must be `shared`: this machine sees the target's files at the same paths. `remote` (copying files over SFTP)
  is not supported and fails the extension's load with a message saying so, like any malformed target.
- The host key is pinned: `knownHostsFile` alone decides, with `StrictHostKeyChecking=yes`. An unknown or changed key
  is refused, never learned, and nothing is written back to the file.
- A settings change reloads the extension. The harness keeps the environment it built for a directory until it closes,
  so configure a target before an agent works in it.

## How it runs

The system `ssh` client, with no config file (`-F /dev/null`), `BatchMode` and one multiplexed connection per target
(`ControlMaster=auto`, `ControlPersist` 10 minutes, the socket in a private temp directory). A command becomes one
remote command line in which every word is single-quoted, so no path, argument or value is interpreted by the remote
shell. Variables the caller sets beyond this process's own reach the command (through `env`, so the wrapper keeps the
target's PATH); the rest of this machine's environment does not replace the target's, and removing a variable is not
passed on. The remote login shell must be POSIX.

On the target a small wrapper changes to the directory (exit 126 when it does not exist), starts the command as its own
session and process group with `setsid`, and watches the SSH channel. Locally `ssh` runs in its own session behind a
shell that holds the channel's input: a TERM, INT or HUP to that shell (an abort, a timeout, a stopped group), or its
death by KILL, closes the input, and the whole remote group gets TERM, then KILL a second later. A group the command
leaves behind when it exits is stopped the same way. The wrapper exits only once its group is gone, and the local
shell waits for `ssh`, so a stop that returns means the remote work has ended (except after a local KILL).

- `run`: execFile semantics, with the remote exit code, stdout, stderr, `signal`, `timeout` and `maxBuffer`.
- `start`: a local `spawnGroup` around `ssh`, streamed; stopping it stops the remote group.
- `env`: Pi's Node environment with the local file system and a `spawn` that runs each shell command over SSH.

## Status

`SshExecApi` (`api.ts`) reports each target as `unchecked`, `ready` or `unreachable` with ssh's reason. The extension
connects to every target when it loads, and again after any command exits 255 (ssh's own failure code). A `run` that
fails because the target is unreachable rejects with `ssh-exec target <id> (<user@host:port>) is unreachable: <reason>`;
the agent's `bash` shows ssh's message with exit 255. While a target is unreachable the setup item warns (`SSH exec`)
with what fails; work outside its root is not affected.

`test/e2e/ssh-exec.test.ts` runs the protocol against an sshd of the current user on a loopback port.
