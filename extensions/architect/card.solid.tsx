import type { EntryRecord } from '@earendil-works/pi-durable'
import { WorkflowIcon } from '@lucide/solid'
import { For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Fold, plural, UserView, useDocOf } from '@/sdk/solid'
import { where } from './drafts.solid.tsx'
import { openArchitecture } from './link.solid.tsx'
import { ArchitectureDoc } from './refs.ts'
import type { ArchitectureComments, ArchitectureQuestion } from './refs.ts'

const chipClass =
  'flex h-auto max-w-full min-w-0 justify-start gap-1.5 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] font-normal hover:border-brand/50 hover:text-foreground'

export function QuestionCard(props: { entry: EntryRecord }) {
  const question = () => props.entry.data as ArchitectureQuestion
  const doc = useDocOf(() => question().branch, ArchitectureDoc)
  const title = () =>
    doc()
      ?.versions.find((item) => item.version === question().version)
      ?.diagrams.find((item) => item.id === question().diagram)?.title ?? question().diagram
  const message = () => {
    const first = props.entry.model?.[0]
    return first?.role === 'user' ? first : undefined
  }
  return (
    <Show when={message()}>
      {(user) => (
        <div
          class="mt-3 flex flex-col items-end first:mt-0"
          data-architect-question={props.entry.id}
        >
          <Button
            aria-label={`Open question #${props.entry.id} in Architecture`}
            class={`-mb-1.5 items-center ${chipClass}`}
            data-architect-chip={`${question().diagram}:${question().part ?? ''}`}
            onClick={() => {
              const { branch, version, diagram, kind, part } = question()
              openArchitecture({
                branch,
                version,
                diagram,
                ...(kind !== 'diagram' && part && { mark: { kind, part } }),
              })
            }}
            size={null}
            title="Open in Architecture"
            type="button"
            variant={null}
          >
            <WorkflowIcon class="size-3 shrink-0 text-brand" />
            <span class="min-w-0 truncate text-foreground/85">{title()}</span>
            {question().kind !== 'diagram' && (
              <span class="min-w-0 truncate text-muted-foreground">· {where(question())}</span>
            )}
            <span class="shrink-0 text-muted-foreground">· v{question().version}</span>
          </Button>
          <div class="w-full">
            <UserView entry={props.entry} message={user()} text={question().text} />
          </div>
        </div>
      )}
    </Show>
  )
}

export function CommentsCard(props: { entry: EntryRecord }) {
  const data = () => props.entry.data as ArchitectureComments
  const doc = useDocOf(() => data().branch, ArchitectureDoc)
  const diagrams = () => doc()?.versions.find((item) => item.version === data().version)?.diagrams
  const titleOf = (id: string) => diagrams()?.find((diagram) => diagram.id === id)?.title ?? id
  const title = () => (
    <>
      Architecture · {plural(data().comments.length, 'comment')} on{' '}
      <span class="text-foreground/85">
        v{data().version} of #{data().branch}
      </span>
    </>
  )
  return (
    <div class="mt-3 flex justify-end first:mt-0">
      <Fold
        card={props.entry.id}
        keep
        label={`Toggle architecture comments #${props.entry.id}`}
        summary={
          <>
            <WorkflowIcon class="size-3 shrink-0 text-brand" />
            {title()}
          </>
        }
      >
        <section
          class="w-full max-w-2xl min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40"
          data-architect-card={props.entry.id}
        >
          <header class="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <WorkflowIcon class="size-3.5 shrink-0 text-brand" />
            <span class="min-w-0 truncate">{title()}</span>
          </header>
          <Show when={data().note}>
            <p class="border-b border-border/60 px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">
              {data().note}
            </p>
          </Show>
          <ol class="divide-y divide-border/60">
            <For each={data().comments}>
              {(comment, index) => (
                <li class="space-y-1.5 px-3 py-2.5">
                  <Button
                    aria-label={`Open comment ${index() + 1} of architecture comments #${props.entry.id}`}
                    class={`items-center ${chipClass}`}
                    data-architect-chip={`${comment.diagram}:${comment.part ?? ''}`}
                    onClick={() =>
                      openArchitecture({
                        branch: data().branch,
                        version: data().version,
                        diagram: comment.diagram,
                        ...(comment.kind !== 'diagram' &&
                          comment.part && { mark: { kind: comment.kind, part: comment.part } }),
                      })
                    }
                    size={null}
                    title="Open in Architecture"
                    type="button"
                    variant={null}
                  >
                    <span class="min-w-0 truncate text-foreground/85">
                      {titleOf(comment.diagram)}
                    </span>
                    {comment.kind !== 'diagram' && (
                      <span class="min-w-0 truncate text-muted-foreground">· {where(comment)}</span>
                    )}
                  </Button>
                  {(comment.kind === 'node' || comment.kind === 'participant') &&
                    comment.label &&
                    comment.label !== comment.part && (
                      <p class="font-mono text-[11px] text-muted-foreground">{comment.label}</p>
                    )}
                  <p class="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
                    {comment.text}
                  </p>
                </li>
              )}
            </For>
          </ol>
        </section>
      </Fold>
    </div>
  )
}
