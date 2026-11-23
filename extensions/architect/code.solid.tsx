import { ArrowUpRightIcon, FileCodeIcon } from '@lucide/solid'
import { Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, events } from '@/sdk/solid'
import { useGithubRepo } from '../workspaces/ui.solid.tsx'
import type { ArchitectureCode, PartCode } from './refs.ts'

const chipClass =
  'flex w-full min-w-0 items-center gap-1.5 rounded border border-border/70 bg-background/60 px-1.5 py-1 font-mono text-[11px]'

export function PartSource(props: { code: PartCode; where?: ArchitectureCode }) {
  const github = useGithubRepo()
  const source = () => props.code.source
  const label = () => {
    const at = source()
    return at && `${at.path}${at.line ? `:${at.line}` : ''}`
  }
  const inReview = () => {
    const at = source()
    const spec = props.where?.spec
    return at && spec && props.where?.changed.includes(at.path) ? spec : undefined
  }
  const blob = () => {
    const at = source()
    const repo = github()
    const where = props.where
    return at && repo && where
      ? `https://${repo}/blob/${encodeURIComponent(where.ref)}/${at.path.split('/').map(encodeURIComponent).join('/')}${at.line ? `#L${at.line}` : ''}`
      : undefined
  }
  const chip = () => {
    const at = source()
    if (!at) return null
    const slash = at.path.lastIndexOf('/') + 1
    return (
      <>
        <FileCodeIcon class="size-3 shrink-0 text-muted-foreground" />
        <span class="flex min-w-0 shrink">
          <span class="min-w-0 shrink-[3] truncate text-muted-foreground">
            {at.path.slice(0, slash)}
          </span>
          <span class="shrink-0 text-foreground/90">
            {at.path.slice(slash)}
            {at.line ? `:${at.line}` : ''}
          </span>
        </span>
      </>
    )
  }
  return (
    <div class="space-y-1 px-3 pt-2" data-architect-part-code={props.code.status}>
      <Show when={source()}>
        {(at) => (
          <Switch
            fallback={
              <span class={chipClass} data-architect-source={label()} title={label()}>
                {chip()}
              </span>
            }
          >
            <Match when={inReview()}>
              {(spec) => (
                <Button
                  aria-label={`Open ${label()} in Review`}
                  class={cn(
                    chipClass,
                    'h-auto justify-start font-normal hover:border-brand/50 hover:text-foreground',
                  )}
                  data-architect-source={label()}
                  onClick={() =>
                    events.emit('review:open', {
                      spec: spec(),
                      at: { file: at().path, line: at().line ?? 1 },
                    })
                  }
                  size={null}
                  title={`Open ${label()} in Review, in the branch's change`}
                  type="button"
                  variant={null}
                >
                  {chip()}
                </Button>
              )}
            </Match>
            <Match when={blob()}>
              {(href) => (
                <a
                  class={cn(chipClass, 'hover:border-brand/50 hover:text-foreground')}
                  data-architect-source={label()}
                  href={href()}
                  rel="noreferrer"
                  target="_blank"
                  title={`Open ${label()} on ${github()}, at ${props.where?.ref}`}
                >
                  {chip()}
                  <ArrowUpRightIcon class="size-2.5 shrink-0 opacity-60" />
                </a>
              )}
            </Match>
          </Switch>
        )}
      </Show>
      <div class="flex min-w-0 items-center gap-1.5">
        <Show when={source()?.symbol}>
          {(symbol) => (
            <span
              class="mr-auto min-w-0 truncate font-mono text-[11px] text-brand/90"
              title={symbol()}
            >
              {symbol()}
            </span>
          )}
        </Show>
        <span
          class={cn(
            'shrink-0 rounded-sm px-1 font-mono text-[10px]',
            props.code.status === 'proposed'
              ? 'border border-dashed border-muted-foreground/60 text-muted-foreground'
              : 'bg-muted text-foreground/75',
          )}
          title={
            props.code.status === 'proposed'
              ? 'Planned, not in the code yet'
              : 'In the code the architect read'
          }
        >
          {props.code.status}
        </span>
        <span
          class="shrink-0 font-mono text-[10px] text-muted-foreground"
          title={
            props.code.evidence === 'runtime'
              ? 'Seen in an observed runtime trace'
              : 'Read from the source, not observed running'
          }
        >
          {props.code.evidence}
        </span>
      </div>
    </div>
  )
}
