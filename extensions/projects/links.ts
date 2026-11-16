import type { RunningProject } from './refs.ts'

export type Page = { hostname: string; protocol: string }

export const onLoopback = ({ hostname }: Page) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)

const port = (url: string) => new URL(url).port || '80'

const servedHere = (project: RunningProject, page: Page) =>
  project.served?.find((origin) => new URL(origin).hostname === page.hostname)

export function target(project: RunningProject, page: Page) {
  if (onLoopback(page)) return `${project.url}/`
  const served = servedHere(project, page)
  if (served) return `${served}/`
  return project.tailnetPort
    ? `${page.protocol}//${page.hostname}:${project.tailnetPort}/`
    : undefined
}

export function shownPort(project: RunningProject, page: Page) {
  if (onLoopback(page)) return `:${port(project.url)}`
  const served = servedHere(project, page)
  if (served) return `:${port(served)}`
  return project.tailnetPort ? `:${project.tailnetPort}` : '—'
}
