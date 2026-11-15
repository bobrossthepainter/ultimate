import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

let parser: Promise<(source: string) => Promise<unknown>> | undefined

async function load() {
  const require = createRequire(realpathSync(fileURLToPath(import.meta.resolve('mermaid'))))
  const cjs = require.resolve('dompurify')
  const builds = [
    require(cjs) as Record<string, unknown>,
    (require(cjs.replace(/[^/]+$/, 'purify.es.mjs')) as { default: Record<string, unknown> })
      .default,
  ]
  for (const purify of builds)
    if (typeof purify.addHook !== 'function')
      Object.assign(purify, {
        addHook() {},
        removeHook() {},
        removeHooks() {},
        removeAllHooks() {},
        sanitize: (text: string) => text,
      })
  const { default: library } = await import('mermaid')
  return (source: string) => library.parse(source)
}

export async function parseError(source: string) {
  parser ??= load()
  try {
    await (
      await parser
    )(source)
    return undefined
  } catch (error) {
    return (error instanceof Error ? error.message : String(error))
      .split('\n')
      .slice(0, 4)
      .join(' ')
  }
}
