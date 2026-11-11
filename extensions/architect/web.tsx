import { WorkflowIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { api, defineWebExtension, getState } from '@/sdk'
import { CommentsCard, QuestionCard } from './card.tsx'
import { Frame, Loading } from './frame.tsx'
import { ArchitectureLink, openArchitecture } from './link.tsx'
import { DrawAction } from './refs.ts'

// Mermaid loads with the surface, not with the app.
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

/** The branch conversation `id` stands for: itself, or the branch its architect draws. */
function branchOf(id: number) {
  const summary = getState().conversations.find((conversation) => conversation.id === id)
  return summary?.label === 'architect' && summary.parentConversationId !== undefined
    ? summary.parentConversationId
    : id
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
      when: (context) => context.conversationId !== undefined,
      run: async (context) => {
        if (context.conversationId === undefined) return
        const branch = branchOf(context.conversationId)
        await api.action(DrawAction, { conversation: branch })
        openArchitecture({ branch })
      },
    },
  ],
  slots: { overlay: [ArchitectureLink] },
  entries: { 'architect.comments': CommentsCard, 'architect.question': QuestionCard },
})
