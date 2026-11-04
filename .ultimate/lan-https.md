# Ultimate over HTTPS on the local network

**Prefer the `caddy` extension** (⌘K → Hosting (Caddy)…, `extensions/caddy/README.md`): it installs and runs Caddy,
gets the domain's certificate by DNS-01, and serves each ticked Ultimate on its own port of that domain, without
`--port` or `--proxy-origin` or a restart. The manual setup below (one subdomain per project) remains for a Caddy you
run yourself.

Serve Ultimates on this network under your own domain with a wildcard certificate: Caddy terminates TLS and routes
one subdomain per project to that project's supervisor, which stays on loopback. Machines outside the network use the
`tailscale` extension instead.

**There is no login.** `--proxy-origin` admits everything Caddy forwards, and Ultimate runs shell commands. Only
publish these names in LAN or VPN DNS, never in public DNS, and keep ports 80/443 closed to the internet.

## Each project

Start every project on a fixed port with its subdomain as the proxy origin:

```sh
pnpm start ~/code/my-app --port 4801 --proxy-origin https://my-app.ultimate.example.com
pnpm start ~/code/other-app --port 4802 --proxy-origin https://other-app.ultimate.example.com
```

`--proxy-origin` needs the default loopback listener (no `--host 0.0.0.0`), so Caddy has to run on the same machine.

## Caddy

`/etc/caddy/Caddyfile`, with the wildcard certificate and key you provide:

```caddyfile
*.ultimate.example.com {
	tls /etc/caddy/certs/wildcard.crt /etc/caddy/certs/wildcard.key

	@my-app host my-app.ultimate.example.com
	handle @my-app {
		reverse_proxy 127.0.0.1:4801
	}

	@other-app host other-app.ultimate.example.com
	handle @other-app {
		reverse_proxy 127.0.0.1:4802
	}

	handle {
		abort
	}
}
```

Caddy keeps the `Host` header, adds `X-Forwarded-*` and streams server-sent events by default, which is what the
proxy origin expects. Ultimate admits a request only when its `Host` and `Origin` match the proxy origin exactly, so a
project added to Caddy also needs its own `--proxy-origin`.

## DNS

Point `*.ultimate.example.com` at this machine's LAN address in your local DNS (router, Pi-hole, or a VPN's DNS).

## Other Ultimates

With cloud backups on, each backup registers this project's address: the tailnet URL when the `tailscale` extension
publishes one, else the HTTPS proxy origin. `ultimate.tell` and codemode's `{ project }` on other machines then find
it through the register. A machine that does not back up (a satellite) is named in `remotes` in the other machines'
user settings:

```json
{ "remotes": { "lab": { "my-app": "https://my-app.ultimate.example.com" } } }
```

## Certificates from an API later

Replace the `tls` line with Caddy's DNS-01 challenge for the wildcard, using the
[caddy-dns](https://github.com/caddy-dns) module for your DNS provider (build it in with `xcaddy`):

```caddyfile
tls {
	dns <provider> {env.DNS_API_TOKEN}
}
```

Nothing changes in Ultimate.
