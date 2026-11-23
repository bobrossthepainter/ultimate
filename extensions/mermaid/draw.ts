import { keepLast } from '../../lib/errors.ts'
import mermaid from 'mermaid'

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

function natural(svg: string) {
  const element = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')!
  const width = element.getAttribute('viewBox')?.split(/\s+/)[2]
  if (width) element.setAttribute('width', width)
  return element.outerHTML
}

let queue: Promise<unknown> = Promise.resolve()
let configured: string | undefined

export function draw(id: string, code: string, theme: 'dark' | 'light') {
  const next = queue.then(() => {
    if (configured !== theme) {
      mermaid.initialize(config(theme))
      configured = theme
    }
    return mermaid.render(id, code).then(({ svg }) => natural(svg))
  })
  queue = next.catch(keepLast)
  return next
}
