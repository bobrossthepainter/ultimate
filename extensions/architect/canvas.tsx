import { MessageSquareIcon, MessagesSquareIcon, SparklesIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn, errorMessage, useStore } from '@/sdk'
import { draw, token } from '../mermaid/ui.tsx'
import { limits } from './drafts.tsx'
import type { Draft } from './drafts.tsx'
import { partAt, partElements, withChangeClasses } from './parts.tsx'
import type { Part } from './parts.tsx'
import type { ArchitectureDiagram } from './refs.ts'

const kinds = ['node', 'edge', 'participant'] as const

/** The change classes' colours from the theme on screen, as hex for Mermaid. */
function palette() {
  return {
    added: token('diff-add'),
    changed: token('warning'),
    removed: token('diff-del'),
    card: token('card'),
    foreground: token('foreground'),
  }
}

/**
 * Hover, click and draft styles of the rendered SVG: parts look clickable and light up in the accent, parts with a
 * draft keep an accent outline. Mermaid's own CSS sits inside the SVG, so these need `!`.
 */
const interactive = cn(
  '[&_g.node]:cursor-pointer [&_[data-architect-hit]]:cursor-pointer [&_.actor]:cursor-pointer [&_.actor-man]:cursor-pointer',
  '[&_g.node:hover_:is(rect,path,polygon,circle,ellipse)]:!stroke-brand',
  '[&_:is(rect,g).actor:hover]:!stroke-brand [&_g.actor-man:hover_*]:!stroke-brand',
  '[&_[data-architect-hit]]:fill-none [&_[data-architect-hit]]:stroke-transparent [&_[data-architect-hit]]:[stroke-width:14px]',
  '[&_[data-architect-hover]]:!stroke-brand',
)

/** Parts the code does not have yet, from `code`: dashed and faded, the edges too. */
const proposedStyle = cn(
  '[&_[data-architect-proposed]_:is(rect,path,polygon,circle,ellipse)]:![stroke-dasharray:5_3]',
  '[&_path[data-architect-proposed]]:![stroke-dasharray:5_3] [&_[data-architect-proposed]]:opacity-75',
)

/** A comment being written: where the click was, on what, and the draft it edits. */
export type Writing = {
  part: Omit<Part, 'kind'> & { kind: Part['kind'] | 'diagram' }
  x: number
  y: number
  id?: string
}

/**
 * One diagram drawn by Mermaid with its change classes. With `onPick`, a click on a part (a node, an edge, a
 * participant) reports it; `drafts` mark the parts that have one and `marked` a part a link pointed at.
 */
export function Canvas({
  diagram,
  svgId,
  drafts = [],
  marked,
  onPick,
  fit = true,
}: {
  diagram: ArchitectureDiagram
  svgId: string
  drafts?: Draft[]
  marked?: Pick<Part, 'kind' | 'part'>
  onPick?: (part: Part, at: { x: number; y: number }) => void
  /** Shrink a wide diagram to the column; without it, it shrinks only to 40rem and the column scrolls (a phone). */
  fit?: boolean
}) {
  const theme = useStore((state) => state.ui.theme)
  const [result, setResult] = useState<{ svg?: string; error?: string; key?: string }>()
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const source = diagram.mermaid
  const drawn = `${svgId}:${theme}:${source}`
  useEffect(() => {
    let cancelled = false
    draw(svgId, withChangeClasses(source, palette()), theme).then(
      (svg) => !cancelled && setResult({ svg, key: drawn }),
      (error: unknown) => !cancelled && setResult({ error: errorMessage(error), key: drawn }),
    )
    return () => {
      cancelled = true
    }
  }, [svgId, source, theme, drawn])
  const svg = result?.key === drawn ? result.svg : undefined
  // The diagram's proposed parts, marked on the SVG for `proposedStyle`.
  useLayoutEffect(() => {
    const root = host.current?.querySelector('svg')
    if (!root || !svg) return
    for (const [part, code] of Object.entries(diagram.code ?? {}))
      if (code.status === 'proposed')
        for (const kind of kinds)
          for (const element of partElements(svgId, root, { kind, part }))
            element.setAttribute('data-architect-proposed', '')
  }, [svg, svgId, diagram.code])
  // Edges are thin: a wide transparent copy of each takes their clicks and hovers.
  useLayoutEffect(() => {
    const root = host.current?.querySelector('svg')
    if (!root || !svg || !onPick) return
    for (const hit of root.querySelectorAll('[data-architect-hit]')) hit.remove()
    for (const path of root.querySelectorAll('.edgePaths path[data-id]')) {
      const hit = path.cloneNode() as SVGPathElement
      hit.setAttribute('data-architect-hit', '')
      hit.removeAttribute('id')
      hit.removeAttribute('marker-end')
      hit.removeAttribute('marker-start')
      hit.removeAttribute('style')
      hit.addEventListener('mouseenter', () => path.setAttribute('data-architect-hover', ''))
      hit.addEventListener('mouseleave', () => path.removeAttribute('data-architect-hover'))
      path.after(hit)
    }
  }, [svg, onPick])
  // A marker at the top right of each part with a draft (and of the part a link pointed at), placed over the SVG.
  const draftKey = drafts
    .map((draft) => `${draft.kind}:${draft.part}:${draft.by === undefined ? 'own' : 'chat'}`)
    .join('|')
  const [markers, setMarkers] = useState<
    { key: string; x: number; y: number; link: boolean; chat: boolean }[]
  >([])
  useLayoutEffect(() => {
    const root = host.current?.querySelector('svg')
    const box = frame.current
    if (!root || !svg || !box) return undefined
    const place = () => {
      const origin = box.getBoundingClientRect()
      // The user's own drafts first: a part with both shows the solid marker.
      const parts = drafts
        .toSorted((a, b) => Number(a.by !== undefined) - Number(b.by !== undefined))
        .flatMap((draft) =>
          draft.kind !== 'diagram' && draft.part
            ? [{ part: { kind: draft.kind, part: draft.part }, chat: draft.by !== undefined }]
            : [],
        )
      const wanted = [
        ...(marked ? [{ part: marked, link: true, chat: false }] : []),
        ...parts.map((item) => ({ ...item, link: false })),
      ]
      const seen = new Set<string>()
      setMarkers(
        wanted.flatMap(({ part, link, chat }) => {
          const key = `${part.kind}:${part.part}`
          if (seen.has(key)) return []
          seen.add(key)
          const elements = partElements(svgId, root, part)
          // An edge's marker sits at its label's corner, or halfway along an unlabelled one.
          const path = elements[0]
          const caption = root
            .querySelector(`.edgeLabel [data-id="${CSS.escape(part.part)}"]`)
            ?.getBoundingClientRect()
          if (part.kind === 'edge' && caption && caption.width > 0)
            return [
              { key, x: caption.right - origin.left, y: caption.top - origin.top, link, chat },
            ]
          if (part.kind === 'edge' && path instanceof SVGPathElement) {
            const middle = path.getPointAtLength(path.getTotalLength() / 2)
            const at = new DOMPoint(middle.x, middle.y).matrixTransform(
              path.getScreenCTM() ?? undefined,
            )
            return [{ key, x: at.x - origin.left, y: at.y - origin.top, link, chat }]
          }
          // A participant is drawn twice (top and bottom): mark the top box.
          const rect = elements
            .map((element) => element.getBoundingClientRect())
            .toSorted((a, b) => a.top - b.top)[0]
          if (!rect) return []
          return [{ key, x: rect.right - origin.left, y: rect.top - origin.top, link, chat }]
        }),
      )
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(box)
    return () => observer.disconnect()
    // `drafts` changes identity on every render; its parts are what matter.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [svg, svgId, draftKey, marked])
  if (result?.key === drawn && result.error)
    return (
      <div className="space-y-2 p-4">
        <p className="font-mono text-[11.5px] text-error" title={result.error}>
          Mermaid could not draw this diagram: {result.error.split('\n')[0]}
        </p>
        <pre className="overflow-auto rounded-md border border-border/70 bg-terminal p-3 font-mono text-[11.5px] text-muted-foreground">
          {source}
        </pre>
      </div>
    )
  return (
    <div className="relative min-h-0 min-w-0" ref={frame}>
      {svg ? (
        <div
          className={cn(
            '[&_svg]:h-auto',
            // A wide diagram fitted to a phone's width is unreadable: there it may grow to 40rem, and the column scrolls.
            fit ? 'flex justify-center [&_svg]:max-w-full' : 'w-max [&_svg]:!max-w-[40rem]',
            proposedStyle,
            onPick && interactive,
          )}
          data-architect-canvas={diagram.id}
          // Mermaid's own output at securityLevel strict, sanitised by its DOMPurify pass.
          dangerouslySetInnerHTML={{ __html: svg }}
          onClick={(event) => {
            const root = host.current?.querySelector('svg')
            if (!root || !onPick || !(event.target instanceof Element)) return
            const part = partAt(svgId, root, event.target, diagram.parts)
            const box = frame.current?.getBoundingClientRect()
            if (part && box)
              onPick(part, { x: event.clientX - box.left, y: event.clientY - box.top })
          }}
          ref={host}
        />
      ) : (
        <div className="h-48 animate-pulse rounded-md bg-muted/40" />
      )}
      {svg &&
        markers.map((marker) => (
          <span
            className={cn(
              'pointer-events-none absolute flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-sm',
              // The chat's suggestions are outlined: the user's own are solid.
              marker.chat
                ? 'border border-brand bg-background text-brand'
                : 'bg-brand text-background',
              marker.link && 'ring-2 ring-brand/40 ring-offset-1 ring-offset-background',
            )}
            data-architect-marker={marker.key}
            data-architect-marker-chat={marker.chat || undefined}
            key={`${marker.key}:${marker.link}`}
            style={{ left: marker.x, top: marker.y }}
          >
            {marker.chat ? (
              <MessagesSquareIcon className="size-2.5" />
            ) : (
              <MessageSquareIcon className="size-2.5" />
            )}
          </span>
        ))}
    </div>
  )
}

/**
 * The comment popover at the clicked part: what it is on, the text, Cancel, Ask AI (`onAsk`: the text as a question to
 * the architecture chat instead of a comment) and Add (⌘↵). While either runs it stays open; when it fails it keeps
 * the text and says why.
 */
export function Composer({
  title,
  label,
  details,
  initial = '',
  submit,
  onSubmit,
  onAsk,
  onCancel,
}: {
  title: ReactNode
  label?: string
  /** What the part is in the code, above the text. */
  details?: ReactNode
  initial?: string
  submit: string
  onSubmit: (text: string) => Promise<unknown>
  onAsk?: (text: string) => Promise<unknown>
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState<'submit' | 'ask'>()
  const [error, setError] = useState<string>()
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => field.current?.focus({ preventScroll: true }), [])
  const ready = !saving && text.trim().length > 0 && text.length <= limits.text
  const save = (how: 'submit' | 'ask' = 'submit') => {
    setSaving(how)
    setError(undefined)
    ;(how === 'ask' ? onAsk! : onSubmit)(text.trim()).then(
      () => setSaving(undefined),
      (failure: unknown) => {
        setSaving(undefined)
        setError(errorMessage(failure))
      },
    )
  }
  return (
    <form
      className="w-[min(22rem,calc(100vw-2rem))] rounded-md border border-brand/40 bg-card font-sans shadow-lg"
      data-architect-composer=""
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) save()
      }}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <MessageSquareIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-[12px] text-foreground/85">Comment on</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {title}
        </span>
      </div>
      {details}
      {label && (
        <p className="truncate px-3 pt-1.5 text-[12px] text-muted-foreground" title={label}>
          {label}
        </p>
      )}
      <textarea
        aria-label="Comment"
        className="block max-h-60 min-h-16 w-full resize-y bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
            event.preventDefault()
            save()
          }
        }}
        placeholder="What should change here?"
        ref={field}
        value={text}
      />
      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-2 py-1.5">
        {text.length > limits.text ? (
          <span className="mr-auto font-mono text-[11px] text-error">
            {text.length} / {limits.text}
          </span>
        ) : (
          error && (
            <span
              className="mr-auto min-w-0 truncate font-mono text-[11px] text-error"
              role="alert"
              title={error}
            >
              {error}
            </span>
          )
        )}
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          Cancel
        </Button>
        {onAsk && (
          <Button
            data-architect-ask=""
            disabled={!ready}
            onClick={() => save('ask')}
            size="xs"
            title="Ask the architecture chat about this part instead of adding a comment"
            type="button"
            variant="outline"
          >
            <SparklesIcon />
            {saving === 'ask' ? 'Asking…' : 'Ask AI'}
          </Button>
        )}
        <Button disabled={!ready} size="xs" type="submit">
          {saving === 'submit' ? 'Saving…' : submit}
        </Button>
      </div>
    </form>
  )
}

/** Where to put a popover of `width` near a click at `x`, `y` inside a box of `bounds` width: below it, kept inside. */
export function popoverAt(x: number, y: number, bounds: number, width = 352) {
  return { left: Math.max(8, Math.min(x - 24, bounds - width - 8)), top: y + 14 }
}
