/**
 * `check_extensions`: format, lint and type-check extension files of any project with the clone's own config, from
 * this process (extension code always loads from the host's filesystem), so it works the same locally, in a pod and
 * over remote SSH.
 */
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { arr, bool, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

const TIMEOUT_MS = 120_000
const PROJECT_EXTENSIONS = `${sep}.ultimate${sep}extensions`

interface Problem {
  file: string
  line: number
  column: number
  message: string
}
/** A type, not an interface: `api.details` takes JSON, and only type aliases are assignable to it. */
export type CheckDetails = {
  roots: string[]
  files: number
  fixed: boolean
  format: number
  lint: number
  types: number
}

/** The extensions folder `path` lies in: a project's `.ultimate/extensions` or the clone's `extensions`. */
function rootOf(clone: string, path: string) {
  const marked = path.lastIndexOf(PROJECT_EXTENSIONS + sep)
  if (marked >= 0) return path.slice(0, marked + PROJECT_EXTENSIONS.length)
  if (path.endsWith(PROJECT_EXTENSIONS)) return path
  const builtins = join(clone, 'extensions')
  if (path === builtins || path.startsWith(builtins + sep)) return builtins
  return undefined
}

/**
 * The `.ts` and `.tsx` files at `path`, a file or a directory (without `node_modules`), by the names under `path`.
 * Links are followed as extension discovery follows them (a linked extension folder is loaded, so it is checked);
 * `seen` holds the real directories visited, so a link cycle ends.
 */
async function sources(path: string, seen = new Set<string>()): Promise<string[]> {
  if (!(await stat(path)).isDirectory())
    return ['.ts', '.tsx'].includes(extname(path)) ? [path] : []
  const real = await realpath(path)
  if (seen.has(real)) return []
  seen.add(real)
  const found: string[] = []
  for (const entry of await readdir(path)) {
    if (entry === 'node_modules') continue
    found.push(...(await sources(join(path, entry), seen)))
  }
  return found
}

/**
 * A checkout-shaped folder whose `.ultimate/extensions` links to `root`, with a tsconfig extending the clone's
 * `config` (`tsconfig.json` for server code, `tsconfig.web.json` for `.tsx`). Project extensions import
 * `../../../server/*.ts` and `@/…` as if they lived in the clone; `rootDirs` maps the folder onto the clone so those
 * resolve, and `node_modules` links to the clone's for `@types/node`, React and Pi.
 */
async function stage(base: string, clone: string, root: string, config: string) {
  const folder = join(base, config === 'tsconfig.json' ? 'node' : 'web')
  await mkdir(join(folder, '.ultimate'), { recursive: true })
  await symlink(root, join(folder, '.ultimate/extensions'))
  await symlink(join(clone, 'node_modules'), join(folder, 'node_modules'))
  // Without it the files are CommonJS to TypeScript, and every import is an error under verbatimModuleSyntax.
  await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n')
  const web = config !== 'tsconfig.json'
  const tsconfig = {
    extends: join(clone, config),
    compilerOptions: {
      rootDirs: [folder, clone],
      // tsconfig.web.json is a composite project with an outDir: every source must lie under rootDir, and the clone
      // files a project extension imports do not lie under this folder.
      ...(web && { composite: false, emitDeclarationOnly: false, noEmit: true, rootDir: '/' }),
    },
    include: [web ? '.ultimate/extensions/**/*.tsx' : '.ultimate/extensions/**/*.ts'],
    references: [],
  }
  await writeFile(join(folder, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))
  return join(folder, '.ultimate/extensions')
}

interface Diagnostic {
  message: string
  code?: string
  filename: string
  labels?: { span: { line: number; column: number } }[]
}

const failed = (error: unknown) =>
  error as Error & { stdout?: string; stderr?: string; code?: unknown }
/** Program output without vp's "running as a built-in command" notes. */
const quiet = (text = '') =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('note: '))
    .join('\n')
    .trim()

/** Check `paths` (absolute files or folders under extension roots) with the clone at `clone`; `fix` formats first. */
export async function checkExtensions(
  clone: string,
  paths: readonly string[],
  { fix = false, signal }: { fix?: boolean; signal?: AbortSignal } = {},
) {
  if (!paths.length) throw new Error('paths must name at least one file or folder')
  const roots = new Map<string, string>()
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`Not an absolute path: ${path}`)
    const root = rootOf(clone, resolve(path))
    if (!root)
      throw new Error(
        `Not under a .ultimate/extensions/ folder or the clone's extensions/: ${path}`,
      )
    await stat(path)
    roots.set(resolve(path), root)
  }
  const vp = join(clone, 'node_modules/.bin/vp')
  const options = { cwd: clone, signal, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
  // Every file checked, by its name under its extension root: the formatter gets exactly these, never a folder, so
  // `fix` writes only extension source files.
  const files = new Map<string, string>()
  for (const [path, root] of roots)
    for (const file of await sources(path)) {
      // A link may point anywhere: what it reaches must be extension code too, or `fix` would format other files.
      if (!rootOf(clone, await realpath(file)))
        throw new Error(
          `${file} links outside a .ultimate/extensions/ folder; check its target instead`,
        )
      if (!files.has(file)) files.set(file, root)
    }
  if (!files.size) throw new Error('No .ts or .tsx files in the given paths')
  const targets = [...files.keys()]
  if (fix) await exec(vp, ['fmt', '--write', ...targets], options)

  const format: string[] = []
  let formatError = ''
  try {
    await exec(vp, ['fmt', '--list-different', ...targets], options)
  } catch (error) {
    const { stdout, stderr, code } = failed(error)
    // Exit 1 lists the files that would change; anything else (a parse error, a timeout) is reported as it came.
    if (code !== 1) formatError = quiet(stderr) || quiet(stdout) || String(error)
    for (const line of (stdout ?? '').split('\n'))
      if (isAbsolute(line.trim())) format.push(line.trim())
  }

  const base = await mkdtemp(join(tmpdir(), 'ultimate-check-'))
  try {
    // Each checked file under the name lint sees it by: staged when outside the clone, so the tsconfig above applies.
    const staged = new Map<string, string>()
    const stages = new Map<string, string>()
    for (const [file, root] of files) {
      if (root.startsWith(clone + sep)) {
        staged.set(file, file)
        continue
      }
      const config = file.endsWith('.tsx') ? 'tsconfig.web.json' : 'tsconfig.json'
      const key = `${root}\0${config}`
      if (!stages.has(key))
        stages.set(key, await stage(join(base, String(stages.size)), clone, root, config))
      staged.set(join(stages.get(key)!, relative(root, file)), file)
    }

    let diagnostics: Diagnostic[] = []
    if (staged.size) {
      // The clone turns react-in-jsx-scope off only for its own paths; with the automatic JSX runtime it never applies.
      const args = ['lint', '-f', 'json', '-A', 'react/react-in-jsx-scope', ...staged.keys()]
      let stdout: string
      try {
        stdout = (await exec(vp, args, options)).stdout
      } catch (error) {
        const result = failed(error)
        if (result.code !== 1 || !result.stdout) throw error
        stdout = result.stdout
      }
      diagnostics = (JSON.parse(stdout) as { diagnostics: Diagnostic[] }).diagnostics
    }

    const rootFor = (file: string) =>
      [...new Set(roots.values())].find((root) => file.startsWith(root + sep)) ?? clone
    const shown = (file: string) => relative(rootFor(file), file)
    const lint: Problem[] = []
    const types: Problem[] = []
    for (const diagnostic of diagnostics) {
      const file = staged.get(diagnostic.filename) ?? diagnostic.filename
      const at = diagnostic.labels?.[0]?.span
      const problem = {
        file: shown(file),
        line: at?.line ?? 0,
        column: at?.column ?? 0,
        message: diagnostic.code ? `${diagnostic.code}: ${diagnostic.message}` : diagnostic.message,
      }
      ;(diagnostic.code?.startsWith('typescript(TS') ? types : lint).push(problem)
    }

    const details: CheckDetails = {
      roots: [...new Set(roots.values())],
      files: staged.size,
      fixed: fix,
      format: format.length + (formatError ? 1 : 0),
      lint: lint.length,
      types: types.length,
    }
    const line = (problem: Problem) =>
      `  ${problem.file}:${problem.line}:${problem.column} ${problem.message}`
    const sections = [
      details.format && [
        `Format (${details.format}):`,
        ...format.map((file) => `  ${shown(file)}`),
        ...(formatError ? [formatError.replace(/^/gm, '  ')] : []),
        ...(fix ? [] : ['  Run again with fix: true to format them.']),
      ],
      lint.length && [`Lint (${lint.length}):`, ...lint.map(line)],
      types.length && [`Types (${types.length}):`, ...types.map(line)],
    ].filter((section): section is string[] => !!section)
    const head = `Checked ${details.files} file${details.files === 1 ? '' : 's'} in ${details.roots.join(', ')}${fix ? ' (formatted first)' : ''}.`
    const text = sections.length
      ? [head, ...sections.map((section) => section.join('\n'))].join('\n\n')
      : `${head}\nAll clean: format, lint and types pass.`
    return { text, details }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

export default function checkExtensionsExtension(host: ExtensionHost) {
  return defineExtension({
    name: 'check-extensions',
    tools: [
      defineTool({
        name: 'check_extensions',
        description:
          "Format-check, lint and type-check extension files in any project's .ultimate/extensions/ (or the clone's extensions/) with Ultimate's own config, as `pnpm check` does in the clone. paths: absolute files or folders under such a folder; fix: true formats them first. Use it after writing or changing an extension outside the clone, instead of guessing with npx prettier or tsc.",
        // Checking only reads the files; a rerun of fix formats them again, which changes nothing the first run did not.
        replay: 'safe',
        parameters: obj({
          paths: arr(str(), { minItems: 1 }),
          fix: opt(bool()),
        }),
        async execute(args, api, context) {
          const { text, details } = await checkExtensions(host.ultimateRoot, args.paths, {
            fix: args.fix,
            signal: context.abortSignal,
          })
          await api.details(details, context)
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
