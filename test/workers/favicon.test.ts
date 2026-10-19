import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('/favicon.svg is the SwayQ mark, not upstream Punctual', () => {
  it('serves the swayq-2026 ring and lime dot', async () => {
    const { default: worker } = await import('../../src/index.js')
    const res = await worker.fetch(
      new Request('https://book.sway-q.com/favicon.svg'),
      env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
    const svg = await res.text()
    expect(svg).toContain('#dbed72')
    expect(svg).toContain('M 320.914 395.209 A 153.6 153.6 0 1 1 395.209 320.914')
    expect(svg).not.toContain('#1FC16B')
    expect(svg).not.toContain('#0F1512')
  })
})
