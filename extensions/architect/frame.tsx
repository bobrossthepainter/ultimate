import { WorkflowIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, Header, StatusLine } from '@/sdk'

/** The surface's frame, as Review's: its header with `controls`, the body, the status line. */
export function Frame({ controls, children }: { controls?: ReactNode; children: ReactNode }) {
  return (
    <>
      <Header>
        <span className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <WorkflowIcon className="size-4 text-muted-foreground" />
          <span className="max-md:hidden">Architecture</span>
        </span>
        {controls}
      </Header>
      <div className="relative flex min-h-0 flex-1">{children}</div>
      <StatusLine />
    </>
  )
}

/** A quiet line in place of the diagrams: why there are none. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex-1 py-10 text-center font-mono text-[11.5px] text-muted-foreground/70">
      {children}
    </p>
  )
}

/** Diagram list and a diagram while the versions load. */
export function Loading() {
  return (
    <>
      <div className="w-64 shrink-0 space-y-2 border-r border-border/70 p-3 max-md:hidden">
        {[60, 45, 70].map((width) => (
          <Skeleton className="h-3.5" key={width} style={{ width: `${width}%` }} />
        ))}
      </div>
      <div className="min-w-0 flex-1 space-y-3 p-4">
        <Skeleton className="h-8" />
        <Skeleton className="h-72" />
      </div>
    </>
  )
}

const swatches = [
  ['added', 'border-diff-add bg-diff-add/20'],
  ['changed', 'border-warning bg-warning/20'],
  ['removed', 'border-dashed border-diff-del bg-diff-del/20'],
] as const

/** What the three change colours mean, and that parts take comments. */
export function Legend() {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground md:px-4">
      {swatches.map(([name, swatch]) => (
        <span className="flex items-center gap-1.5" key={name}>
          <span className={cn('size-2.5 rounded-[3px] border', swatch)} />
          {name}
        </span>
      ))}
      <span className="ml-auto text-muted-foreground/60 max-md:hidden">
        click a part or a title to comment
      </span>
    </div>
  )
}
