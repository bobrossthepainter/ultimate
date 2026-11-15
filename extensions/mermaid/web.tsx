import { lazy, Suspense } from 'react'
import { defineWebExtension } from '@/sdk'

const Diagram = lazy(() => import('./diagram.tsx'))

export default defineWebExtension({
  codeBlocks: {
    mermaid: ({ code, incomplete, core }) =>
      incomplete ? (
        core
      ) : (
        <Suspense fallback={core}>
          <Diagram code={code} core={core} />
        </Suspense>
      ),
  },
})
