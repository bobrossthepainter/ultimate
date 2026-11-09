import { expect, it, vi } from 'vitest'

vi.mock('@/sdk', () => ({ api: {}, defineWebExtension: (facet: unknown) => facet }))
vi.mock('../../extensions/messages/ui.tsx', () => ({}))

const { closeAnswered } = await import('../../extensions/push/web.tsx')

// WebKit (iOS) registrations have no getNotifications; calling it crashed the push facet (#49).
it('leaves a registration without getNotifications alone', () => {
  const registration = {} as ServiceWorkerRegistration
  expect(() => closeAnswered(registration, new Set(['message:1']))).not.toThrow()
})
