import { Code, Workflow } from '@lucide/solid'
import { createEffect, createSignal, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, errorMessage } from '@/sdk/solid'
import type { CodeBlockRenderer } from '@/sdk/solid'

let next = 0
const theme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

function useTheme() {
  const [current, setCurrent] = createSignal<'dark' | 'light'>(theme())
  onSettled(() => {
    const observer = new MutationObserver(() => setCurrent(theme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  })
  return current
}

export const Diagram: CodeBlockRenderer = (props) => {
  const id = `mermaid-${next++}`
  const current = useTheme()
  const [result, setResult] = createSignal<{ svg?: string; error?: string }>()
  const [source, setSource] = createSignal(false)
  createEffect(
    () => (props.incomplete ? undefined : { code: props.code, theme: current() }),
    (input) => {
      if (!input) return undefined
      let cancelled = false
      import('./draw.ts')
        .then(({ draw }) => draw(id, input.code, input.theme))
        .then(
          (svg) => !cancelled && setResult({ svg }),
          (error: unknown) => !cancelled && setResult({ error: errorMessage(error) }),
        )
      return () => {
        cancelled = true
      }
    },
  )
  const error = () =>
    result()
      ?.error?.split('\n')
      .filter((line, index, lines) => index === 0 || index === lines.length - 1)
      .join(' · ')
  const svg = () => (props.incomplete || source() ? undefined : result()?.svg)
  return (
    <Show
      when={!error() || props.incomplete}
      fallback={
        <div class="space-y-1">
          {props.core}
          <p class="font-mono text-[11px] text-error">Mermaid: {error()}</p>
        </div>
      }
    >
      <Show
        when={svg()}
        fallback={
          <div class="group relative">
            {props.core}
            <Show when={!props.incomplete && result()?.svg}>
              <Toggle class="right-9" onClick={() => setSource(false)} source />
            </Show>
          </div>
        }
      >
        {(drawn) => (
          <div class="group relative">
            <div class="w-full rounded-md border bg-terminal p-3">
              <Svg markup={drawn()} />
            </div>
            <Toggle class="right-1" onClick={() => setSource(true)} source={false} />
          </div>
        )}
      </Show>
    </Show>
  )
}

function Svg(props: { markup: string }) {
  let box: HTMLDivElement | undefined
  createEffect(
    () => props.markup,
    (markup) => {
      if (box) box.innerHTML = markup
    },
  )
  return <div ref={box} class="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full" />
}

function Toggle(props: { class: string; onClick: () => void; source: boolean }) {
  const label = () => (props.source ? 'Show diagram' : 'Show source')
  return (
    <Button
      aria-label={label()}
      class={cn(
        'absolute top-1 size-7 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        props.class,
      )}
      onClick={() => props.onClick()}
      size="icon"
      title={label()}
      variant="ghost"
    >
      <Show when={props.source} fallback={<Code class="size-3.5" />}>
        <Workflow class="size-3.5" />
      </Show>
    </Button>
  )
}
