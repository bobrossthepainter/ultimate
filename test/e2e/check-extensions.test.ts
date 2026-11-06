import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTemps, temp } from '../helpers.ts'
import { checkExtensions } from '../../extensions/check-extensions/server.ts'

afterEach(removeTemps)

async function extension(files: Record<string, string>) {
  const root = join(await temp(), '.ultimate/extensions')
  await mkdir(join(root, 'demo'), { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'demo', name), text)
  return root
}

const clean = `import type { ActionContext } from '../../../server/actions.ts'
import { readFile } from 'node:fs/promises'

export const read = (ctx: ActionContext) => readFile(ctx.host.projectRoot, 'utf8')
`

it("reports format, lint and type errors of a project's extension with the clone's config", async () => {
  const root = await extension({
    'server.ts': `import type { ActionContext } from '../../../server/actions.ts'
export function run(_ctx: ActionContext) {
  try { JSON.parse('') } catch {}
  const n: number = 'a'
  return n
}
`,
  })
  const { text, details } = await checkExtensions(resolve('.'), [join(root, 'demo')])
  expect(details).toMatchObject({ files: 1, format: 1, lint: 1, types: 1 })
  expect(text).toContain('Format (1):\n  demo/server.ts')
  expect(text).toContain('demo/server.ts:3:26 ultimate(no-silent-catch)')
  expect(text).toContain("demo/server.ts:4:9 typescript(TS2322): Type 'string' is not assignable")
  // The clone-relative type import resolves: no "Cannot find module".
  expect(text).not.toContain('TS2307')
})

it('reports a clean extension as clean', async () => {
  const root = await extension({ 'server.ts': clean })
  const { text, details } = await checkExtensions(resolve('.'), [join(root, 'demo/server.ts')])
  expect(details).toMatchObject({ files: 1, format: 0, lint: 0, types: 0 })
  expect(text).toContain('All clean')
})

it('refuses relative paths and paths outside an extensions folder', async () => {
  await expect(checkExtensions(resolve('.'), ['demo/server.ts'])).rejects.toThrow('absolute')
  await expect(checkExtensions(resolve('.'), [await temp()])).rejects.toThrow(
    '.ultimate/extensions',
  )
})
