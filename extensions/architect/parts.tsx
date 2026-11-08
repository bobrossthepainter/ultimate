/**
 * Mermaid's rendered SVG mapped back to the source: which part a click landed on, and the change classes' `classDef`s
 * added to a source before it renders. Verified against mermaid 12.3.0 (`securityLevel: 'strict'`).
 */
import type { ArchitectureComment } from './refs.ts'

export type Change = 'added' | 'changed' | 'removed'
export const changes: readonly Change[] = ['added', 'changed', 'removed']

/** A part of a rendered diagram: what a comment names. */
export type Part = {
  kind: Exclude<ArchitectureComment['kind'], 'diagram'>
  part: string
  label: string
}

/** The diagram type: the first keyword after front matter, directives and comments. */
export function diagramType(source: string) {
  const body = source.replace(/^\s*---[\s\S]*?\n---\s*\n/, '')
  for (const line of body.split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('%%')) continue
    return text.split(/\s/)[0] ?? ''
  }
  return ''
}

// Types whose nodes take `:::class` and `classDef`; a sequence diagram fails to parse with a `classDef` line.
const classable = /^(flowchart|graph|classDiagram|stateDiagram|erDiagram)/

/** How many parts each change class marks, for the diagram list. */
export function changeCounts(source: string) {
  const counts: Record<Change, number> = { added: 0, changed: 0, removed: 0 }
  for (const match of source.matchAll(/:::(added|changed|removed)\b/g)) counts[match[1] as Change]++
  for (const match of source.matchAll(/^\s*cssClass\s+"([^"]*)"\s+(added|changed|removed)\b/gm))
    counts[match[2] as Change] += match[1].split(',').length
  for (const match of source.matchAll(/^\s*class\s+([\w,\s]+?)\s+(added|changed|removed)\s*;?$/gm))
    counts[match[2] as Change] += match[1].split(',').length
  return counts
}

/** Hex colours of the change classes, in the theme on screen. */
export type Palette = Record<Change, string> & { card: string; foreground: string }

const mix = (a: string, b: string, weight: number) => {
  const channel = (hex: string, at: number) =>
    Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16)
  return `#${[0, 1, 2]
    .map((at) =>
      Math.round(channel(a, at) * weight + channel(b, at) * (1 - weight))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** `source` with `classDef added/changed/removed` appended, where its type takes them and it defines none itself. */
export function withChangeClasses(source: string, palette: Palette) {
  if (!classable.test(diagramType(source))) return source
  const lines = changes
    .filter((change) => !new RegExp(`^\\s*classDef\\s+${change}\\b`, 'm').test(source))
    .map((change) => {
      const colour = palette[change]
      const style = [
        `fill:${mix(colour, palette.card, 0.18)}`,
        `stroke:${colour}`,
        'stroke-width:1.5px',
        `color:${palette.foreground}`,
        ...(change === 'removed' ? ['stroke-dasharray:4 3'] : []),
      ]
      return `  classDef ${change} ${style.join(',')}`
    })
  return lines.length ? `${source.trimEnd()}\n${lines.join('\n')}\n` : source
}

const text = (element: Element | null | undefined) =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The source ID of a node group: `<svg>-flowchart-<id>-<n>`, `-classId-`, `-entity-`, `-state-`. */
export function nodeId(svgId: string, group: Element) {
  const id = group.id.startsWith(`${svgId}-`) ? group.id.slice(svgId.length + 1) : group.id
  return /^(?:flowchart|classId|entity|state)-(.+)-\d+$/.exec(id)?.[1]
}

/** The ID of every node in `svg`, for telling apart an edge's ends. */
function nodeIds(svgId: string, svg: Element) {
  return new Set([...svg.querySelectorAll('g.node')].flatMap((group) => nodeId(svgId, group) ?? []))
}

/**
 * An edge's ends from its `data-id`: `L_<from>_<to>_<n>` (flowchart), `id_<from>_<to>_<n>` (class),
 * `id_entity-<from>-<i>_entity-<to>-<j>_<n>` (ER). IDs may hold `_`, so the split is the one whose two sides are nodes.
 */
function edgeEnds(id: string, nodes: Set<string>) {
  const er = /^id_entity-(.+)-\d+_entity-(.+)-\d+_\d+$/.exec(id)
  if (er) return [er[1], er[2]] as const
  const rest = /^(?:L|id)_(.+)_\d+$/.exec(id)?.[1]
  if (!rest) return undefined
  for (let at = rest.indexOf('_'); at !== -1; at = rest.indexOf('_', at + 1)) {
    const from = rest.slice(0, at)
    const to = rest.slice(at + 1)
    if (nodes.has(from) && nodes.has(to)) return [from, to] as const
  }
  return undefined
}

/** The part a click on `target` inside rendered `svg` landed on, if any. */
export function partAt(
  svgId: string,
  svg: Element,
  target: Element,
  names: Record<string, string>,
): Part | undefined {
  // A sequence diagram's participant: its boxes, stick figure and lifeline carry `name`; their text sits beside them.
  const actor = target.closest('[name].actor, [name].actor-man, [name].actor-line')
  const actorGroup = target.closest('text.actor')?.parentElement
  const participant =
    actor?.getAttribute('name') ??
    actorGroup?.querySelector('[name]')?.getAttribute('name') ??
    actorGroup?.getAttribute('data-id')
  if (participant)
    return {
      kind: 'participant',
      part: participant,
      label:
        text(actorGroup?.querySelector('text.actor')) ||
        text(actor?.querySelector('text.actor')) ||
        text(svg.querySelector(`[name="${CSS.escape(participant)}"] ~ text.actor`)) ||
        names[participant] ||
        participant,
    }
  const node = target.closest('g.node')
  if (node) {
    const id = nodeId(svgId, node)
    if (id)
      return {
        kind: 'node',
        part: id,
        label: text(node.querySelector('.label')) || text(node) || id,
      }
  }
  const edge = target.closest('[data-id]')
  const edgeId = edge?.getAttribute('data-id')
  if (edge && edgeId && edge.closest('.edgePaths, .edgeLabels, [data-architect-hit]')) {
    const ends = edgeEnds(edgeId, nodeIds(svgId, svg))
    const caption = text(svg.querySelector(`.edgeLabel [data-id="${CSS.escape(edgeId)}"]`))
    const route = ends ? `${ends[0]} → ${ends[1]}` : ''
    return {
      kind: 'edge',
      part: edgeId,
      label: [route, caption].filter(Boolean).join(': ') || edgeId,
    }
  }
  return undefined
}

/** The elements that draw `part`, for marking it: a node's group, an edge's path, a participant's boxes. */
export function partElements(svgId: string, svg: Element, part: Pick<Part, 'kind' | 'part'>) {
  const id = CSS.escape(part.part)
  if (part.kind === 'participant')
    return [...svg.querySelectorAll(`rect.actor[name="${id}"], g.actor-man[name="${id}"]`)]
  if (part.kind === 'edge') return [...svg.querySelectorAll(`.edgePaths path[data-id="${id}"]`)]
  return [...svg.querySelectorAll('g.node')].filter((group) => nodeId(svgId, group) === part.part)
}
