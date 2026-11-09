import { ArrowUpRightIcon, FileCodeIcon } from 'lucide-react'
import { cn } from '@/sdk'
import { openReview } from '../review/ui.tsx'
import { useGithubRepo } from '../workspaces/ui.tsx'
import type { ArchitectureCode, PartCode } from './refs.ts'

/**
 * Where a part lives in the code and how sure the drawing is, above its comment: the source as a link and the part's
 * status and evidence. A file the branch changes opens in Review at its line; the rest opens on GitHub at the branch
 * the code is on, else shows as plain text.
 */
export function PartSource({ code, where }: { code: PartCode; where?: ArchitectureCode }) {
  const github = useGithubRepo()
  const source = code.source
  const label = source && `${source.path}${source.line ? `:${source.line}` : ''}`
  const chip = source && (
    <>
      <FileCodeIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-foreground/85">{label}</span>
      {source.symbol && (
        <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{source.symbol}</span>
      )}
    </>
  )
  const chipClass =
    'flex max-w-full min-w-0 items-center gap-1.5 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px]'
  const link = !source ? null : where?.spec && where.changed.includes(source.path) ? (
    <button
      className={cn(chipClass, 'cursor-pointer hover:border-brand/50 hover:text-foreground')}
      data-architect-source={label}
      onClick={() => openReview(where.spec!, { file: source.path, line: source.line ?? 1 })}
      title={`Open ${label} in Review, in the branch's change`}
      type="button"
    >
      {chip}
    </button>
  ) : github && where ? (
    <a
      className={cn(chipClass, 'hover:border-brand/50 hover:text-foreground')}
      data-architect-source={label}
      href={`https://${github}/blob/${where.ref}/${source.path}${source.line ? `#L${source.line}` : ''}`}
      rel="noreferrer"
      target="_blank"
      title={`Open ${label} on ${github}, at ${where.ref}`}
    >
      {chip}
      <ArrowUpRightIcon className="size-2.5 shrink-0 opacity-60" />
    </a>
  ) : (
    <span className={chipClass} data-architect-source={label} title={label}>
      {chip}
    </span>
  )
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 px-3 pt-2"
      data-architect-part-code={code.status}
    >
      {link}
      <span
        className={cn(
          'shrink-0 rounded-sm px-1 font-mono text-[10px]',
          code.status === 'proposed'
            ? 'border border-dashed border-muted-foreground/60 text-muted-foreground'
            : 'bg-muted text-foreground/75',
        )}
        title={
          code.status === 'proposed'
            ? 'Planned, not in the code yet'
            : 'In the code the architect read'
        }
      >
        {code.status}
      </span>
      <span
        className="shrink-0 font-mono text-[10px] text-muted-foreground"
        title={
          code.evidence === 'runtime'
            ? 'Seen in an observed runtime trace'
            : 'Read from the source, not observed running'
        }
      >
        {code.evidence}
      </span>
    </div>
  )
}
