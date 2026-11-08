/**
 * Mermaid for other extensions' browser code: `draw` renders a diagram to an SVG string in the theme's colours, one at a
 * time through Mermaid's single global renderer, and `token` reads a theme token as hex for a diagram's own styles.
 * Importing this loads Mermaid (several MB): import it only from a lazily loaded module.
 */
import mermaid from 'mermaid'

/** A theme token as `#rrggbb`: Mermaid derives shades from its colours and cannot read `oklch()` or `var()`. */
export function token(name: string) {
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

/**
 * `code` drawn as an SVG string at its natural size, in the theme's colours. `id` becomes the SVG's id and the prefix
 * of its elements' ids, so it must be unique on the page.
 */
export function draw(id: string, code: string, theme: 'dark' | 'light') {
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
