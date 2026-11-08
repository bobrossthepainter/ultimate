import type { EntryRecord } from '@earendil-works/pi-durable'
import { WorkflowIcon } from 'lucide-react'
import { Fold, plural, useDocOf } from '@/sdk'
import { where } from './drafts.tsx'
import { openArchitecture } from './link.tsx'
import { ArchitectureDoc } from './refs.ts'
import type { ArchitectureComments } from './refs.ts'

/**
 * Feedback the user sent on a version, in its recipient's transcript: on the user's side, like their typed messages,
 * as Review's card. Each comment's chip opens the surface at that branch, version, diagram and part.
 */
export function CommentsCard({ entry }: { entry: EntryRecord }) {
  const { branch, version, comments, note } = entry.data as ArchitectureComments
  const doc = useDocOf(branch, ArchitectureDoc)
  const diagrams = doc?.versions.find((item) => item.version === version)?.diagrams
  const titleOf = (id: string) => diagrams?.find((diagram) => diagram.id === id)?.title ?? id
  const title = (
    <>
      Architecture · {plural(comments.length, 'comment')} on{' '}
      <span className="text-foreground/85">
        v{version} of #{branch}
      </span>
    </>
  )
  return (
    <div className="mt-3 flex justify-end first:mt-0">
      <Fold
        card={entry.id}
        keep
        summary={
          <>
            <WorkflowIcon className="size-3 shrink-0 text-brand" />
            {title}
          </>
        }
      >
        <section
          className="w-full max-w-2xl min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40"
          data-architect-card={entry.id}
        >
          <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <WorkflowIcon className="size-3.5 shrink-0 text-brand" />
            <span className="min-w-0 truncate">{title}</span>
          </header>
          {note && (
            <p className="border-b border-border/60 px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">
              {note}
            </p>
          )}
          <ol className="divide-y divide-border/60">
            {comments.map((comment, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Fixed submitted comments can share the same part.
              <li className="space-y-1.5 px-3 py-2.5" key={index}>
                <button
                  className="flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] hover:border-brand/50 hover:text-foreground"
                  data-architect-chip={`${comment.diagram}:${comment.part ?? ''}`}
                  onClick={() =>
                    openArchitecture({
                      branch,
                      version,
                      diagram: comment.diagram,
                      ...(comment.kind !== 'diagram' &&
                        comment.part && { mark: { kind: comment.kind, part: comment.part } }),
                    })
                  }
                  title="Open in Architecture"
                  type="button"
                >
                  <span className="min-w-0 truncate text-foreground/85">
                    {titleOf(comment.diagram)}
                  </span>
                  {comment.kind !== 'diagram' && (
                    <span className="min-w-0 truncate text-muted-foreground">
                      · {where(comment)}
                    </span>
                  )}
                </button>
                {(comment.kind === 'node' || comment.kind === 'participant') &&
                  comment.label &&
                  comment.label !== comment.part && (
                    <p className="font-mono text-[11px] text-muted-foreground">{comment.label}</p>
                  )}
                <p className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
                  {comment.text}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </Fold>
    </div>
  )
}
