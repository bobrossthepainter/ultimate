import { CodeIcon, WorkflowIcon } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn, errorMessage, useStore } from '@/sdk'
import { draw } from './ui.tsx'

/** A `mermaid` fence drawn as its diagram, in the theme's colours, with its source a click away. */
export default function Diagram({ code, core }: { code: string; core: ReactNode }) {
  const theme = useStore((state) => state.ui.theme)
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const [result, setResult] = useState<{ svg?: string; error?: string }>()
  const [source, setSource] = useState(false)
  useEffect(() => {
    let cancelled = false
    draw(id, code, theme).then(
      (svg) => !cancelled && setResult({ svg }),
      (error: unknown) => !cancelled && setResult({ error: errorMessage(error) }),
    )
    return () => {
      cancelled = true
    }
  }, [id, code, theme])
  if (result?.error)
    return (
      <div className="space-y-1">
        {core}
        <p className="font-mono text-[11px] text-error">
          Mermaid:{' '}
          {result.error
            .split('\n')
            .filter((line, index, lines) => index === 0 || index === lines.length - 1)
            .join(' · ')}
        </p>
      </div>
    )
  if (!result?.svg || source)
    return (
      <div className="group relative">
        {core}
        {result?.svg && <Toggle className="right-9" onClick={() => setSource(false)} source />}
      </div>
    )
  return (
    <div className="group relative">
      <div className="w-full rounded-md border bg-terminal p-3">
        <div
          className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid's own output at securityLevel strict, sanitised by its DOMPurify pass.
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      </div>
      <Toggle className="right-1" onClick={() => setSource(true)} source={false} />
    </div>
  )
}

function Toggle({
  className,
  onClick,
  source,
}: {
  className: string
  onClick: () => void
  source: boolean
}) {
  const Icon = source ? WorkflowIcon : CodeIcon
  return (
    <Button
      aria-label={source ? 'Show diagram' : 'Show source'}
      className={cn(
        'absolute top-1 size-7 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        className,
      )}
      onClick={onClick}
      size="icon"
      title={source ? 'Show diagram' : 'Show source'}
      variant="ghost"
    >
      <Icon className="size-3.5" />
    </Button>
  )
}
