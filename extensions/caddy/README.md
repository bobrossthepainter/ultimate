Serve this machine's Ultimates over HTTPS on your own domain through one Caddy, ticked per project in the Hosting panel, with a wildcard certificate from DNS-01 or your own files.

**There is no login.** Anyone who reaches a served address can run commands. Publish `*.<domain>` only in LAN or VPN
DNS, never in public DNS, and keep the port closed to the internet. For access from outside, use `tailscale`.

## Hosting panel

⌘K **Hosting (Caddy)…** opens it; the status line's `caddy` item does too while this Ultimate is served (green) or
needs a fix (amber).

- **Setup:** the domain (`ultimate.example.com`; each project is `<name>.ultimate.example.com`), the HTTPS port
  (9443 by default, so it never competes with another proxy on 443), and the certificate: **DNS-01** with a
  [caddy-dns](https://github.com/caddy-dns) provider name and its API token, or **Own files** for a wildcard
  certificate and key you keep up to date yourself.
- **Caddy:** **Install** downloads Caddy with the provider's module from caddyserver.com into `~/.ultimate/caddy/`.
  A binary without the module shows "lacks <provider>"; install again after changing providers.
- **Ultimates on this machine:** every project with a home in `~/.ultimate/projects/` (`host.projects()`): its
  checkbox (serve by Caddy), its loopback port or "stopped", its Caddy address, and a link that opens it in a new tab:
  the Caddy address while it is served, else its tailnet address when this page came over the tailnet, else its
  loopback URL when this page is on loopback. Ultimates of another clone or another user's home are not listed.
- **Services (Linux):** each project can run in the background as the systemd user service
  `ultimate@<home folder>.service` (`pnpm setup:machine --project <dir>`). A row shows **Start** while its service is
  stopped, **Stop** while systemd runs it, and **Install as service** while it has none; this Ultimate's own row
  never offers Stop. Stop and Start queue the job (`--no-block`) and return; the overview shows the change within 5 s.
  Without a reachable user systemd, and in previews, no row offers them.

## Settings and the token

User settings only (`~/.ultimate/settings.json`), shared by every project:

```json
{
  "caddy": {
    "domain": "ultimate.example.com",
    "port": 9443,
    "dns": "cloudflare",
    "serve": { "/home/me/code/my-app": { "subdomain": "my-app" } }
  }
}
```

`cert` and `key` (absolute paths) replace `dns`. The token is the `CADDY_DNS_API_TOKEN` secret (⌘K → Secrets), declared
while `dns` is set. Caddy reads it as `{env.CADDY_DNS_API_TOKEN}` from its own environment, so neither the written
Caddyfile nor Caddy's loaded config holds it, and Caddy saves no config (`persist_config off`). A changed token
restarts Caddy with the new one at the next apply (a settings change, a server start, or **Apply again**).

## How a tick takes effect

The extension reloads on every settings change, in every running Ultimate. Each server applies only its own
project, without a restart:

1. It claims its subdomain in `~/.ultimate/caddy/routes.json`, under a pid-owned lock, with its loopback URL and an
   owner token. Entries of dead servers drop out; a subdomain held by another root is refused.
2. It writes `~/.ultimate/caddy/Caddyfile` (one wildcard site, a `host` route per subdomain, everything else
   aborted) and loads it through Caddy's admin API on the owner-only socket `~/.ultimate/caddy/admin.sock`,
   starting Caddy in the background (`caddy start`) when none runs. Caddy outlives the Ultimates; it stops on
   reboot and the first ticked server to start brings it back.
3. It registers `https://<subdomain>.<domain>:<port>` as an allowed origin (`host.access.allow`), the runtime form of
   `--proxy-origin`. Cloud backups register it as the project's address when Tailscale publishes none.

Unticking, or the server closing, removes its route and its origin. A server listening on every interface
(`--host 0.0.0.0`) is refused, since a LAN client could then send the proxy's `Host` directly; previews and scratch
homes are never served.

## Actions

- `overview` → `{ config, tokenSet, caddy: { installed, version?, module?, running }, status, projects }`.
- `status` → this server's `{ state, url?, hint? }`; states `off`, `unconfigured`, `not-installed`, `missing-module`,
  `not-loopback`, `starting`, `ready`, `error`.
- `retry` → applies again and returns the status.
- User-only: `configure { domain, port?, dns? | cert, key }`, `serve { root, on }`, `install`,
  `service { root, run: 'start' | 'stop' | 'install' }`.

`CADDY_COMMAND` names another binary; tests point it at a stub.
