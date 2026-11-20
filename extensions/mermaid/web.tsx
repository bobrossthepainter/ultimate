import { defineWebExtension } from '@/sdk'
import { Diagram } from './diagram.solid.tsx'

export default defineWebExtension({ codeBlocks: { mermaid: Diagram } })
