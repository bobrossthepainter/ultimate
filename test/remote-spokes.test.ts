import { describe, expect, it } from 'vitest'
import { spokesOf } from '../lib/remote.ts'

describe('spokesOf', () => {
  it('skips this instance under its key, keeps same-named checkouts apart, and lets remotes win over the register', () => {
    const spokes = spokesOf({
      here: 'desk',
      self: ['my-app', 'github.com/example/my-app'],
      projects: [
        { name: 'my-app', current: true },
        { name: 'shop', current: false, running: { url: 'http://127.0.0.1:5001' } },
        { name: 'shop', current: false, running: { url: 'http://127.0.0.1:5002' } },
      ],
      remotes: [
        { machine: 'desk', name: 'github.com/example/my-app', url: 'http://desk:4747' },
        { machine: 'laptop', name: 'api', url: 'http://laptop-lan:4747' },
      ],
      register: {
        projects: [
          {
            hash: 'h1',
            key: 'github.com/example/api',
            name: 'api',
            latest: {
              id: 'b',
              machine: 'laptop',
              at: 0,
              bytes: 0,
              uploaded: 0,
              parent: null,
              tailnet: 'https://laptop.example.ts.net',
            },
          },
        ],
        machines: [
          {
            machine: 'server',
            at: 0,
            projects: { h1: { name: 'api', at: 0, tailnet: 'https://server.example.ts.net' } },
          },
        ],
      },
    })
    expect(spokes.map((spoke) => spoke.url)).toEqual([
      'http://127.0.0.1:5001',
      'http://127.0.0.1:5002',
      'http://laptop-lan:4747',
      'https://server.example.ts.net',
    ])
  })
})
