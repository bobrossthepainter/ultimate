import { WorkflowIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { api, defineWebExtension } from '@/sdk'
import { drawableBranchNow } from './branch.tsx'
import { CommentsCard, QuestionCard } from './card.tsx'
import { Frame, Loading } from './frame.tsx'
import { ArchitectureLink, openArchitecture } from './link.tsx'
import { DrawAction } from './refs.ts'

const Viewer = lazy(() => import('./surface.tsx'))

function ArchitectureSurface() {
  return (
    <Suspense
      fallback={
        <Frame>
          <Loading />
        </Frame>
      }
    >
      <Viewer />
    </Suspense>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'architecture',
      title: 'Architecture',
      icon: WorkflowIcon,
      description: "A branch's architecture diagrams, version by version, to comment on",
      order: 65,
      component: ArchitectureSurface,
    },
  ],
  commands: [
    {
      id: 'architect.open',
      title: 'Open Architecture',
      run: (context) => context.showSurface('architecture'),
    },
    {
      id: 'architect.draw',
      title: 'Draw architecture',
      when: (context) =>
        context.conversationId !== undefined &&
        drawableBranchNow(context.conversationId) !== undefined,
      run: async (context) => {
        if (context.conversationId === undefined) return
        const branch = drawableBranchNow(context.conversationId)
        if (branch === undefined) return
        await api.action(DrawAction, { conversation: branch })
        openArchitecture({ branch })
      },
    },
  ],
  slots: { overlay: [ArchitectureLink] },
  entries: { 'architect.comments': CommentsCard, 'architect.question': QuestionCard },
})
