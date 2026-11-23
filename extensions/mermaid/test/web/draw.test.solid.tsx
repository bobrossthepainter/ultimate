import { expect, it, vi } from 'vitest'

const htmlLabel =
  '<svg id="d" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" style="max-width: 120px;"><g><foreignObject width="60" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>line1<br>line2</p></span></div></foreignObject></g></svg>'

vi.mock('mermaid', () => ({
  default: { initialize: () => undefined, render: async () => ({ svg: htmlLabel }) },
}))

it('draws a label with an HTML line break as an svg at its natural width', async () => {
  const { draw } = await import('../../draw.ts')
  const host = document.createElement('div')
  host.innerHTML = await draw('d', 'flowchart TD\n  A["line1<br>line2"]', 'light')
  const svg = host.firstElementChild!
  expect(svg.tagName.toLowerCase()).toBe('svg')
  expect(svg.getAttribute('width')).toBe('120')
  expect(svg.querySelector('parsererror')).toBeNull()
  expect(svg.querySelector('p')!.innerHTML).toBe('line1<br>line2')
})
