import { lazy, Suspense } from 'react'
import { defineWebExtension } from '@/sdk'

// Mermaid is large (about 3.7 MB minified, split): it loads with the first diagram shown, not with the app.
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
