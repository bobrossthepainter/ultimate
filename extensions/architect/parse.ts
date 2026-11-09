/**
 * Mermaid's parser on the server, so a diagram the surface could not draw is refused at publish and the architect fixes
 * it (#22557: a stray space in `id[("Store") ]` published a diagram that only showed its parse error). Loaded on first
 * use.
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

let parser: Promise<(source: string) => Promise<unknown>> | undefined

async function load() {
  // Mermaid sanitises labels while it parses, through DOMPurify, which without a DOM (Node) has no `addHook` or
  // `sanitize` and makes every flowchart with a label throw. Parsing needs neither: the module instances Mermaid may
  // import (its ESM build under Node, its CommonJS build under Vite's loader) get no-op hooks and an identity
  // `sanitize`. Nothing else on the server uses DOMPurify.
  const require = createRequire(realpathSync(fileURLToPath(import.meta.resolve('mermaid'))))
  const cjs = require.resolve('dompurify')
  // `require` of the ESM build, not `import()`: Vite's loader would evaluate its own copy, not Node's that Mermaid gets.
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

/** The first line of Mermaid's parse error for `source`, or undefined when it parses. */
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
