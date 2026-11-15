import { hostname } from 'node:os'
import type { JsonValue } from '@earendil-works/chord/json'
import { cloudConfig, fetchRegister } from './cloud.ts'
import type { Register } from './cloud.ts'
import { projectIdentity } from './project-identity.ts'
import { readSettings, userSettingsPath } from './settings.ts'
import type { ExtensionHost } from '../server/extensions.ts'

export const REMOTE_BYTES = 1024 * 1024

type LocalProject = {
  name: string
  root?: string
  current: boolean
  running?: { url: string }
}
export type Target =
  | { current: true }
  | { url: string; label: string; name: string; machine?: string }

const naming = (project: string) => (item: { name?: string; key?: string }) =>
  [item.name, item.key].some((value) => value?.toLowerCase() === project.toLowerCase())

export function resolveProject(
  project: string,
  local: (LocalProject & { key?: string })[],
  register: Register | undefined,
  machine?: { name: string; here: boolean },
): Target {
  const named = naming(project)
  const here = machine && !machine.here ? [] : local.filter(named)
  if (here.length > 1)
    throw new Error(
      `${project} names ${here.length} projects on this machine: ${here.map((item) => item.root).join(', ')}; use its key`,
    )
  const [found] = here
  if (found?.current) return { current: true }
  if (found?.running)
    return {
      url: found.running.url,
      label: `${found.name} on this machine`,
      name: found.name,
    }
  const entry = register?.projects.find(named)
  if (entry && !machine?.here) {
    const on = machine?.name ?? entry.latest.machine
    const tailnet =
      (on === entry.latest.machine ? entry.latest.tailnet : undefined) ??
      register!.machines.find((item) => item.machine === on)?.projects[entry.hash]?.tailnet
    if (tailnet)
      return {
        url: tailnet,
        label: `${entry.name} on ${on}`,
        name: entry.name,
        machine: on,
      }
    throw new Error(
      machine
        ? `${entry.name} on ${on} registered no tailnet address`
        : `${entry.name} was last backed up from ${on}, which registered no tailnet address`,
    )
  }
  if (found) throw new Error(`${found.name} is not running on this machine; start it to query it`)
  const known = [
    ...new Set([
      ...local.map((item) => item.name),
      ...(register?.projects ?? []).map((item) => item.name),
    ]),
  ]
  throw new Error(
    `Unknown project ${project}${machine && !machine.here ? ` on ${machine.name}` : ''}${register ? '' : ' (another machine is reached only through remotes in user settings or cloud backups)'}. Known: ${known.join(', ') || 'none'}`,
  )
}

async function userConfiguredRemotes(host: Pick<ExtensionHost, 'userHome'>) {
  const reportedInvalidSettingsMeanUnset = () => ({})
  const settings = await readSettings(userSettingsPath(host.userHome)).catch(
    reportedInvalidSettingsMeanUnset,
  )
  const object = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return Object.entries(object('remotes' in settings ? settings.remotes : undefined)).flatMap(
    ([machine, projects]) =>
      Object.entries(object(projects)).flatMap(([name, url]) =>
        typeof url === 'string' ? [{ machine, name, url }] : [],
      ),
  )
}

async function machineName(host: Pick<ExtensionHost, 'userHome' | 'notice'>) {
  return (await cloudConfig(host))?.machine ?? hostname()
}

export async function selfAddress(host: ExtensionHost) {
  const current = (await host.projects()).find((item) => item.current)
  if (!current) throw new Error('This project is not listed among the projects')
  return { project: current.name, machine: await machineName(host) }
}

export async function reachable(host: ExtensionHost) {
  const errors: string[] = []
  const here = await machineName(host)
  const seen = new Set<string>()
  const spokes: { project: string; machine?: string; label: string }[] = []
  const add = (project: string, machine: string | undefined, label: string) => {
    const key = `${project.toLowerCase()}@${machine ?? here}`
    if (seen.has(key)) return
    seen.add(key)
    spokes.push({ project, ...(machine !== undefined && { machine }), label })
  }
  const projects = await Promise.all(
    (await host.projects()).map(async (item) => ({
      ...item,
      key: item.root ? (await projectIdentity(item.root))?.key : undefined,
    })),
  )
  for (const item of projects)
    if (item.current) seen.add(`${(item.key ?? item.name).toLowerCase()}@${here}`)
  for (const item of projects)
    if (!item.current && item.running)
      add(item.key ?? item.name, undefined, `${item.name} on this machine`)
  for (const item of await userConfiguredRemotes(host))
    add(item.name, item.machine, `${item.name} on ${item.machine}`)
  const cloud = await cloudConfig(host)
  if (cloud)
    try {
      const register = await fetchRegister(cloud)
      for (const entry of register.projects)
        if (entry.latest.tailnet && entry.latest.machine !== here)
          add(entry.key, entry.latest.machine, `${entry.name} on ${entry.latest.machine}`)
      const keys = new Map(register.projects.map((entry) => [entry.hash, entry.key]))
      for (const machine of register.machines)
        if (machine.machine !== here)
          for (const [hash, project] of Object.entries(machine.projects))
            if (project.tailnet)
              add(
                keys.get(hash) ?? project.name,
                machine.machine,
                `${project.name} on ${machine.machine}`,
              )
    } catch (error) {
      errors.push(`cloud register: ${String(error)}`)
    }
  return { spokes, errors }
}

export async function locate(host: ExtensionHost, project: string, machine?: string) {
  const projects = await host.projects()
  const local = await Promise.all(
    projects.map(async (item) => ({
      ...item,
      key: project.includes('/') && item.root ? (await projectIdentity(item.root))?.key : undefined,
    })),
  )
  const here = machine === undefined ? undefined : machine === (await machineName(host))
  const runsHere = local.some((item) => naming(project)(item) && (item.current || item.running))
  if (here !== false && runsHere) return resolveProject(project, local, undefined)
  if (here !== true) {
    const named = (await userConfiguredRemotes(host)).filter(
      (item) => naming(project)(item) && (machine === undefined || item.machine === machine),
    )
    if (named.length > 1)
      throw new Error(
        `${project} runs on ${named.map((item) => item.machine).join(', ')} in remotes; name the machine`,
      )
    const [remote] = named
    if (remote)
      return {
        url: remote.url,
        label: `${remote.name} on ${remote.machine}`,
        name: remote.name,
        machine: remote.machine,
      }
  }
  const cloud = here === true ? undefined : await cloudConfig(host)
  const requiredCloudRegister = cloud ? await fetchRegister(cloud) : undefined
  return resolveProject(
    project,
    local,
    requiredCloudRegister,
    machine === undefined ? undefined : { name: machine, here: here! },
  )
}

export async function postAction(
  target: { url: string; label: string },
  extension: string,
  action: string,
  args: JsonValue,
  signal?: AbortSignal,
): Promise<unknown> {
  const admittedOrigin = new URL(target.url).origin
  const response = await fetch(`${target.url}/api/extensions/${extension}/actions/${action}`, {
    method: 'POST',
    headers: { Origin: admittedOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
  }).catch((error: unknown) => {
    throw new Error(`${target.label} did not answer at ${target.url}: ${String(error)}`)
  })
  const text = await response.text()
  if (Buffer.byteLength(text) > REMOTE_BYTES)
    throw new Error(`${target.label} answered more than 1 MiB; ask for a smaller limit`)
  const body = (() => {
    try {
      return JSON.parse(text) as { result?: unknown; error?: string }
    } catch {
      return { error: text.slice(0, 200) }
    }
  })()
  if (response.status === 403)
    throw new Error(
      `${target.label} refused the call (403): your tailnet login is not in its tailscale.allow`,
    )
  if (!response.ok) throw new Error(`${target.label}: ${body.error ?? response.status}`)
  return body.result
}
