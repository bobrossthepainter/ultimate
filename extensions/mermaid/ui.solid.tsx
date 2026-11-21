/** @jsxImportSource @solidjs/web */
/**
 * Mermaid for other extensions' browser code: `draw` renders a diagram to an SVG string at its natural size in the
 * theme's colours, one at a time through Mermaid's single global renderer (`id` becomes the SVG's id and its elements'
 * id prefix, so it must be unique on the page), and `token` reads a theme token as `#rrggbb` for a diagram's own styles.
 * Importing this loads Mermaid (several MB): import it only from a lazily loaded module.
 */
export { draw, token } from './draw.ts'
