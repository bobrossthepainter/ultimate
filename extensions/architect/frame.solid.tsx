/** @jsxImportSource @solidjs/web */
import { WorkflowIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For } from 'solid-js'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import { cn, Header, StatusLine } from '@/sdk/solid'

export function Frame(props: { controls?: JSX.Element; children: JSX.Element }) {
  return (
    <>
      <Header>
        <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <WorkflowIcon class="size-4 text-muted-foreground" />
          <span class="max-md:hidden">Architecture</span>
        </span>
        {props.controls}
      </Header>
      <div class="relative flex min-h-0 flex-1">{props.children}</div>
      <StatusLine />
    </>
  )
}

export function Notice(props: { children: JSX.Element }) {
  return (
    <p class="flex-1 py-10 text-center font-mono text-[11.5px] text-muted-foreground/70">
      {props.children}
    </p>
  )
}

export function Loading() {
  return (
    <>
      <div class="w-64 shrink-0 space-y-2 border-r border-border/70 p-3 max-md:hidden">
        <For each={[60, 45, 70]}>
          {(width) => <Skeleton class="h-3.5" style={{ width: `${width}%` }} />}
        </For>
      </div>
      <div class="min-w-0 flex-1 space-y-3 p-4">
        <Skeleton class="h-8" />
        <Skeleton class="h-72" />
      </div>
    </>
  )
}

const swatches = [
  ['added', 'border-diff-add bg-diff-add/20'],
  ['changed', 'border-warning bg-warning/20'],
  ['removed', 'border-dashed border-diff-del bg-diff-del/20'],
] as const

export function Legend(props: { proposed?: boolean }) {
  return (
    <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground md:px-4">
      <For each={swatches}>
        {([name, swatch]) => (
          <span class="flex items-center gap-1.5">
            <span class={cn('size-2.5 rounded-[3px] border', swatch)} />
            {name}
          </span>
        )}
      </For>
      {props.proposed && (
        <span class="flex items-center gap-1.5" title="Planned, not in the code yet">
          <span class="size-2.5 rounded-[3px] border border-dashed border-muted-foreground opacity-75" />
          proposed
        </span>
      )}
      <span class="ml-auto text-muted-foreground/60 max-md:hidden">
        click a part to see its source or comment
      </span>
    </div>
  )
}
