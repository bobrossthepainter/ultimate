import { expect, it } from 'vitest'
import ultimate from '../lint/ultimate.ts'

type Context = Parameters<(typeof ultimate.rules)['no-retired-ui']['create']>[0]
function context(text = '', reason = '') {
  const reports: string[] = []
  return {
    reports,
    context: {
      filename: 'test/example.test.ts',
      options: [],
      sourceCode: {
        text,
        getCommentsBefore: () => (reason ? [{ value: reason }] : []),
        getCommentsInside: () => [],
      },
      report: ({ message }) => reports.push(message),
    } satisfies Context,
  }
}

const imported = (source: string, name?: string) => ({
  type: 'ImportDeclaration',
  source: { type: 'Literal', value: source },
  specifiers: [{ imported: { type: 'Identifier', name } }],
})

it('rejects process imports and real sleeps, but allows IO yields, fake timers and reasoned exceptions', () => {
  const f = context()
  const rule = ultimate.rules['no-real-wait-in-fast-tests'].create(f.context)
  for (const source of ['node:child_process', 'child_process', 'execa', 'execa/lib'])
    rule.ImportDeclaration(imported(source))
  rule.ImportDeclaration(imported('node:timers/promises', 'setTimeout'))
  expect(f.reports).toHaveLength(5)
  rule.ImportExpression({
    type: 'ImportExpression',
    source: { type: 'Literal', value: 'node:child_process' },
  })
  rule.ImportDeclaration({
    type: 'ImportDeclaration',
    source: { type: 'Literal', value: 'node:timers/promises' },
    specifiers: [{ type: 'ImportNamespaceSpecifier' }],
  })
  expect(f.reports).toHaveLength(7)
  rule.ImportDeclaration(imported('node:timers/promises', 'setImmediate'))
  expect(f.reports).toHaveLength(7)
  const sleep = {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: 'setTimeout' },
    parent: { type: 'NewExpression', callee: { type: 'Identifier', name: 'Promise' } },
  }
  rule.CallExpression(sleep)
  expect(f.reports).toHaveLength(8)
  const fake = context('vi.useFakeTimers()')
  ultimate.rules['no-real-wait-in-fast-tests'].create(fake.context).CallExpression(sleep)
  expect(fake.reports).toEqual([])
  const reason = context('', 'fast-test-reason: inspect the subprocess boundary')
  ultimate.rules['no-real-wait-in-fast-tests']
    .create(reason.context)
    .ImportDeclaration(imported('node:child_process'))
  expect(reason.reports).toEqual([])
})

it('rejects spawning in extension code that bypasses the exec service, but allows types and pure helpers', () => {
  const f = context()
  const rule = ultimate.rules['no-unrouted-exec'].create(f.context)
  for (const source of ['node:child_process', '../../../lib/exec.ts', '../../lib/spawn.ts'])
    rule.ImportDeclaration(imported(source, 'exec'))
  rule.ImportDeclaration(imported('../../lib/process-group.ts', 'spawnGroup'))
  rule.ImportDeclaration(imported('../../lib/git.ts', 'git'))
  rule.ImportExpression({
    type: 'ImportExpression',
    source: { type: 'Literal', value: 'child_process' },
  })
  expect(f.reports).toHaveLength(6)
  rule.ImportDeclaration(imported('../../lib/process-group.ts', 'groupAlive'))
  rule.ImportDeclaration(imported('../../lib/git.ts', 'isolatable'))
  rule.ImportDeclaration({ ...imported('node:child_process', 'ChildProcess'), importKind: 'type' })
  rule.ImportDeclaration({
    type: 'ImportDeclaration',
    source: { type: 'Literal', value: 'node:child_process' },
    specifiers: [{ imported: { type: 'Identifier', name: 'ChildProcess' }, importKind: 'type' }],
  })
  expect(f.reports).toHaveLength(6)
})

it('rejects retired UI labels case-insensitively and only the board surface property', () => {
  const f = context()
  const rule = ultimate.rules['no-retired-ui'].create(f.context)
  for (const value of ['Branch from here', 'clear context', 'New conversation'])
    rule.Literal({ type: 'Literal', value })
  rule.Literal({
    type: 'Literal',
    value: 'board',
    parent: { type: 'Property', key: { type: 'Identifier', name: 'surface' } },
  })
  expect(f.reports).toHaveLength(4)
  rule.Literal({ type: 'Literal', value: 'board' })
  rule.Literal({ type: 'Literal', value: 'Start a branch' })
  rule.Literal({ type: 'Literal', value: 'SIDE CHAT' })
  expect(f.reports).toHaveLength(4)
})

it('rejects local polling function declarations in favor of the shared real-deadline helper', () => {
  const f = context()
  const rule = ultimate.rules['no-local-test-polling'].create(f.context)
  for (const name of ['until', 'waitFor', 'fixture'])
    rule.FunctionDeclaration({ type: 'FunctionDeclaration', id: { type: 'Identifier', name } })
  expect(f.reports).toHaveLength(2)
})
