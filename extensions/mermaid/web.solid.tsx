import { defineWebExtension } from '@/sdk/solid'
import { Diagram } from './diagram.solid.tsx'

export default defineWebExtension({ codeBlocks: { mermaid: Diagram } })
