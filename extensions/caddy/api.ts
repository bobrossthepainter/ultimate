/**
 * Caddy: other extensions publish a loopback service of theirs on the domain, next to this project's own address.
 */
import { defineApi } from '../../shared/extension-api.ts'

export type CaddyService = {
  /**
   * Serve `target` (a loopback URL) at `https://<domain>:<port>` while this server runs, through the machine's Caddy.
   * Resolves that origin, or undefined when this project is not served by Caddy (unticked, unconfigured, no binary);
   * throws when another project holds `port`. Call `unpublish` once the service is gone.
   */
  publish(port: number, target: string): Promise<string | undefined>
  /** Stop serving `port` when this server published it; a no-op otherwise. */
  unpublish(port: number): Promise<void>
}
/** Publishing loopback services through Caddy; `want` it, since caddy is optional. */
export const CaddyApi = defineApi<CaddyService>()('caddy')
