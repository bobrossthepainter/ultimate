/** @jsxImportSource @solidjs/web */
import { WorkflowIcon } from '@lucide/solid'
import { Loading as LoadingBoundary, lazy } from 'solid-js'
import { api, defineWebExtension, writerNow, writingAs } from '@/sdk/solid'
import { drawableBranchNow } from './branch.solid.tsx'
import { CommentsCard, QuestionCard } from './card.solid.tsx'
import { Frame, Loading } from './frame.solid.tsx'
import { ArchitectureLink, openArchitecture } from './link.solid.tsx'
import { DrawAction } from './refs.ts'

const Viewer = lazy(() => import('./surface.solid.tsx'))

function ArchitectureSurface() {
  return (
    <LoadingBoundary
      fallback={
        <Frame>
          <Loading />
        </Frame>
      }
    >
      <Viewer />
    </LoadingBoundary>
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
        const who = writerNow()
        await api.action(DrawAction, { conversation: branch })
        writingAs(who, () => openArchitecture({ branch }))
      },
    },
  ],
  slots: { overlay: [ArchitectureLink] },
  entries: { 'architect.comments': CommentsCard, 'architect.question': QuestionCard },
})
