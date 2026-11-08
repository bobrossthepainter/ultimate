import mermaid from 'mermaid'
import { CodeIcon, WorkflowIcon } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn, errorMessage, useStore } from '@/sdk'

/** A theme token as `#rrggbb`: Mermaid derives shades from its colours and cannot read `oklch()` or `var()`. */
function token(name: string) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return '#888888'
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`)
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function config(theme: 'dark' | 'light') {
  const background = token('terminal')
  const card = token('card')
  const foreground = token('foreground')
  const muted = token('muted-foreground')
  const border = token('border')
  const brand = token('brand')
  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-sans')
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    // Without it a parse error also leaves Mermaid's error graphic at the end of the page.
    suppressErrorRendering: true,
    flowchart: { nodeSpacing: 30, rankSpacing: 36, padding: 10, minNodeWidth: 60 },
    fontSize: 13,
    sequence: {
      width: 110,
      height: 40,
      actorMargin: 40,
      messageMargin: 30,
    },
    theme: 'base',
    fontFamily,
    themeVariables: {
      darkMode: theme === 'dark',
      fontFamily,
      fontSize: '13px',
      background,
      mainBkg: card,
      primaryColor: card,
      primaryTextColor: foreground,
      primaryBorderColor: brand,
      secondaryColor: token('muted'),
      tertiaryColor: background,
      lineColor: muted,
      textColor: foreground,
      clusterBkg: background,
      clusterBorder: border,
      noteBkgColor: token('muted'),
      noteTextColor: foreground,
      noteBorderColor: border,
      actorBkg: card,
      actorBorder: brand,
      actorTextColor: foreground,
      signalColor: muted,
      signalTextColor: foreground,
      edgeLabelBackground: background,
    },
  } as const
}

/**
 * The SVG at most its own size: Mermaid scales every diagram to the column's width, which blows small ones up.
 */
function natural(svg: string) {
  const element = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const width = element.getAttribute('viewBox')?.split(/\s+/)[2]
  if (width) element.setAttribute('width', width)
  return new XMLSerializer().serializeToString(element)
}

// Mermaid keeps one global configuration and render scratch space: renders run one at a time.
let queue: Promise<unknown> = Promise.resolve()
let configured: string | undefined

function draw(id: string, code: string, theme: 'dark' | 'light') {
  const next = queue.then(() => {
    if (configured !== theme) {
      mermaid.initialize(config(theme))
      configured = theme
    }
    return mermaid.render(id, code).then(({ svg }) => natural(svg))
  })
  queue = next.catch(() => {
    // A failed diagram is reported by its own block; the next render must still run.
  })
  return next
}

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
