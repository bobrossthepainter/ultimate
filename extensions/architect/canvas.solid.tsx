/** @jsxImportSource @solidjs/web */
import { MessageSquareIcon, MessagesSquareIcon, SparklesIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { cn, errorMessage, useStore } from '@/sdk/solid'
import { draw, token } from '../mermaid/ui.solid.tsx'
import { limits } from './drafts.solid.tsx'
import type { Draft } from './drafts.solid.tsx'
import { partAt, partElements, withChangeClasses } from './parts.solid.tsx'
import type { Part } from './parts.solid.tsx'
import type { ArchitectureDiagram } from './refs.ts'

const kinds = ['node', 'edge', 'participant'] as const

function palette() {
  return {
    added: token('diff-add'),
    changed: token('warning'),
    removed: token('diff-del'),
    card: token('card'),
    foreground: token('foreground'),
  }
}

const interactive = cn(
  '[&_g.node]:cursor-pointer [&_[data-architect-hit]]:cursor-pointer [&_.actor]:cursor-pointer [&_.actor-man]:cursor-pointer',
  '[&_g.node:hover_:is(rect,path,polygon,circle,ellipse)]:!stroke-brand',
  '[&_:is(rect,g).actor:hover]:!stroke-brand [&_g.actor-man:hover_*]:!stroke-brand',
  '[&_[data-architect-hit]]:fill-none [&_[data-architect-hit]]:stroke-transparent [&_[data-architect-hit]]:[stroke-width:14px]',
  '[&_[data-architect-hover]]:!stroke-brand',
)

const proposedStyle = cn(
  '[&_[data-architect-proposed]_:is(rect,path,polygon,circle,ellipse)]:![stroke-dasharray:5_3]',
  '[&_path[data-architect-proposed]]:![stroke-dasharray:5_3] [&_[data-architect-proposed]]:opacity-75',
)

export type Writing = {
  part: Omit<Part, 'kind'> & { kind: Part['kind'] | 'diagram' }
  x: number
  y: number
  id?: string
}

type Marker = { key: string; x: number; y: number; link: boolean; chat: boolean }

type Drawn = { svg?: string; error?: string; key: string }

function markersOf(
  svgId: string,
  root: SVGSVGElement,
  box: HTMLElement,
  drafts: readonly Draft[],
  marked: Pick<Part, 'kind' | 'part'> | undefined,
): Marker[] {
  const origin = box.getBoundingClientRect()
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
  return wanted.flatMap(({ part, link, chat }) => {
    const key = `${part.kind}:${part.part}`
    if (seen.has(key)) return []
    seen.add(key)
    const elements = partElements(svgId, root, part)
    const path = elements[0]
    const caption = root
      .querySelector(`.edgeLabel [data-id="${CSS.escape(part.part)}"]`)
      ?.getBoundingClientRect()
    if (part.kind === 'edge' && caption && caption.width > 0)
      return [{ key, x: caption.right - origin.left, y: caption.top - origin.top, link, chat }]
    if (part.kind === 'edge' && path instanceof SVGPathElement) {
      const middle = path.getPointAtLength(path.getTotalLength() / 2)
      const at = new DOMPoint(middle.x, middle.y).matrixTransform(path.getScreenCTM() ?? undefined)
      return [{ key, x: at.x - origin.left, y: at.y - origin.top, link, chat }]
    }
    const rect = elements
      .map((element) => element.getBoundingClientRect())
      .toSorted((a, b) => a.top - b.top)[0]
    if (!rect) return []
    return [{ key, x: rect.right - origin.left, y: rect.top - origin.top, link, chat }]
  })
}

function markProposed(svgId: string, root: SVGSVGElement, diagram: ArchitectureDiagram) {
  for (const [part, code] of Object.entries(diagram.code ?? {}))
    if (code.status === 'proposed')
      for (const kind of kinds)
        for (const element of partElements(svgId, root, { kind, part }))
          element.setAttribute('data-architect-proposed', '')
}

function addEdgeHits(root: SVGSVGElement) {
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
}

export function Canvas(props: {
  diagram: ArchitectureDiagram
  svgId: string
  drafts?: Draft[]
  marked?: Pick<Part, 'kind' | 'part'>
  onPick?: (part: Part, at: { x: number; y: number }) => void
  fit?: boolean
}) {
  const theme = useStore((state) => state.ui.theme)
  const [result, setResult] = createSignal<Drawn>()
  const [markers, setMarkers] = createSignal<Marker[]>([])
  const [root, setRoot] = createSignal<SVGSVGElement>()
  let frame: HTMLDivElement | undefined
  const fit = () => props.fit ?? true
  const pickable = () => props.onPick !== undefined
  const request = createMemo(() => ({
    svgId: props.svgId,
    source: props.diagram.mermaid,
    theme: theme(),
    key: `${props.svgId}:${theme()}:${props.diagram.mermaid}`,
  }))
  createEffect(request, (wanted) => {
    let cancelled = false
    draw(wanted.svgId, withChangeClasses(wanted.source, palette()), wanted.theme).then(
      (svg) => !cancelled && setResult({ svg, key: wanted.key }),
      (error: unknown) => !cancelled && setResult({ error: errorMessage(error), key: wanted.key }),
    )
    return () => {
      cancelled = true
    }
  })
  const drawn = createMemo(() => {
    const current = result()
    return current?.key === request().key ? current : undefined
  })
  const svg = () => drawn()?.svg
  createEffect(
    () => ({ svgRoot: root(), svgId: props.svgId, diagram: props.diagram, pick: pickable() }),
    ({ svgRoot, svgId, diagram, pick }) => {
      if (!svgRoot) return
      markProposed(svgId, svgRoot, diagram)
      if (pick) addEdgeHits(svgRoot)
    },
  )
  createEffect(
    () => ({
      svgRoot: root(),
      svgId: props.svgId,
      drafts: [...(props.drafts ?? [])],
      marked: props.marked,
    }),
    ({ svgRoot, svgId, drafts, marked }) => {
      const box = frame
      if (!svgRoot || !box) return undefined
      const place = () => setMarkers(markersOf(svgId, svgRoot, box, drafts, marked))
      place()
      const observer = new ResizeObserver(place)
      observer.observe(box)
      return () => observer.disconnect()
    },
  )
  const pick = (event: MouseEvent) => {
    const svgRoot = root()
    const onPick = props.onPick
    if (!svgRoot || !onPick || !(event.target instanceof Element)) return
    const part = partAt(props.svgId, svgRoot, event.target, props.diagram.parts)
    const box = frame?.getBoundingClientRect()
    if (part && box) onPick(part, { x: event.clientX - box.left, y: event.clientY - box.top })
  }
  return (
    <Show
      when={drawn()?.error}
      fallback={
        <div class="relative min-h-0 min-w-0" ref={frame}>
          <Show when={svg()} fallback={<div class="h-48 animate-pulse rounded-md bg-muted/40" />}>
            {(markup) => (
              <Svg
                class={cn(
                  '[&_svg]:h-auto',
                  fit() ? 'flex justify-center [&_svg]:max-w-full' : 'w-max [&_svg]:!max-w-[40rem]',
                  proposedStyle,
                  pickable() && interactive,
                )}
                id={props.diagram.id}
                markup={markup()}
                onClick={pick}
                onRoot={setRoot}
              />
            )}
          </Show>
          <Show when={svg()}>
            <For each={markers()} keyed={(marker) => `${marker.key}:${marker.link}`}>
              {(marker) => (
                <span
                  class={cn(
                    'pointer-events-none absolute flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-sm',
                    marker().chat
                      ? 'border border-brand bg-background text-brand'
                      : 'bg-brand text-background',
                    marker().link && 'ring-2 ring-brand/40 ring-offset-1 ring-offset-background',
                  )}
                  data-architect-marker={marker().key}
                  data-architect-marker-chat={marker().chat || undefined}
                  style={{ left: `${marker().x}px`, top: `${marker().y}px` }}
                >
                  {marker().chat ? (
                    <MessagesSquareIcon class="size-2.5" />
                  ) : (
                    <MessageSquareIcon class="size-2.5" />
                  )}
                </span>
              )}
            </For>
          </Show>
        </div>
      }
    >
      {(error) => (
        <div class="space-y-2 p-4">
          <p class="font-mono text-[11.5px] text-error" title={error()}>
            Mermaid could not draw this diagram: {error().split('\n')[0]}
          </p>
          <pre class="overflow-auto rounded-md border border-border/70 bg-terminal p-3 font-mono text-[11.5px] text-muted-foreground">
            {props.diagram.mermaid}
          </pre>
        </div>
      )}
    </Show>
  )
}

function Svg(props: {
  class: string
  id: string
  markup: string
  onClick: (event: MouseEvent) => void
  onRoot: (root: SVGSVGElement | undefined) => void
}) {
  let host: HTMLDivElement | undefined
  createEffect(
    () => props.markup,
    (markup) => {
      if (!host) return
      host.innerHTML = markup
      props.onRoot(host.querySelector('svg') ?? undefined)
    },
  )
  return (
    <div
      class={props.class}
      data-architect-canvas={props.id}
      data-agent-hidden
      ref={(element) => {
        host = element
        element.addEventListener('click', (event) => props.onClick(event))
      }}
    />
  )
}

export function Composer(props: {
  title: JSX.Element
  label?: string
  details?: JSX.Element
  initial?: string
  submit: string
  onSubmit: (text: string) => Promise<unknown>
  onAsk?: (text: string) => Promise<unknown>
  onCancel: () => void
}) {
  const [draft, setText] = createSignal<string>()
  const text = () => draft() ?? props.initial ?? ''
  const [saving, setSaving] = createSignal<'submit' | 'ask'>()
  const [error, setError] = createSignal<string>()
  let field: HTMLTextAreaElement | undefined
  onSettled(() => field?.focus({ preventScroll: true }))
  const ready = () => !saving() && text().trim().length > 0 && text().length <= limits.text
  const save = (how: 'submit' | 'ask') => {
    const handler = how === 'ask' ? props.onAsk : props.onSubmit
    if (!ready() || !handler) return undefined
    setSaving(how)
    setError(undefined)
    return handler(text().trim()).then(
      () => setSaving(undefined),
      (failure: unknown) => {
        setSaving(undefined)
        setError(errorMessage(failure))
      },
    )
  }
  return (
    <Form
      class="w-[min(22rem,calc(100vw-2rem))] rounded-md border border-brand/40 bg-card font-sans shadow-lg"
      data-architect-composer=""
    >
      <div class="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <MessageSquareIcon class="size-3.5 shrink-0 text-brand" />
        <span class="shrink-0 text-[12px] text-foreground/85">Comment on</span>
        <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {props.title}
        </span>
      </div>
      {props.details}
      <Show when={props.label}>
        {(label) => (
          <p class="truncate px-3 pt-1.5 text-[12px] text-muted-foreground" title={label()}>
            {label()}
          </p>
        )}
      </Show>
      <Textarea
        aria-label="Architecture comment text"
        class="block max-h-60 min-h-16 w-full resize-y rounded-none border-0 bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onCancel()
        }}
        onValueChange={setText}
        placeholder="What should change here?"
        ref={field}
        submitShortcut="mod+enter"
        value={text()}
      />
      <div class="flex items-center justify-end gap-2 border-t border-border/60 px-2 py-1.5">
        {text().length > limits.text ? (
          <span class="mr-auto font-mono text-[11px] text-error">
            {text().length} / {limits.text}
          </span>
        ) : (
          error() && (
            <span
              class="mr-auto min-w-0 truncate font-mono text-[11px] text-error"
              role="alert"
              title={error()}
            >
              {error()}
            </span>
          )
        )}
        <Button
          aria-label="Cancel architecture comment"
          onClick={() => props.onCancel()}
          size="xs"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Show when={props.onAsk}>
          <Button
            aria-label="Ask the architecture chat"
            data-architect-ask=""
            disabled={!ready()}
            onClick={() => save('ask')}
            size="xs"
            title="Ask the architecture chat about this part instead of adding a comment"
            type="button"
            variant="outline"
          >
            <SparklesIcon />
            {saving() === 'ask' ? 'Asking…' : 'Ask AI'}
          </Button>
        </Show>
        <Button
          aria-label={
            props.submit === 'Save' ? 'Save architecture comment' : 'Add architecture comment'
          }
          disabled={!ready()}
          onClick={() => save('submit')}
          size="xs"
          type="submit"
        >
          {saving() === 'submit' ? 'Saving…' : props.submit}
        </Button>
      </div>
    </Form>
  )
}

export function popoverAt(x: number, y: number, bounds: number, width = 352) {
  return { left: `${Math.max(8, Math.min(x - 24, bounds - width - 8))}px`, top: `${y + 14}px` }
}
