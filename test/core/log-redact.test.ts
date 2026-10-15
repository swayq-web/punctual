import { describe, expect, it } from 'vitest'

import { redactUrl, redactUrlsIn } from '../../src/log-redact.js'

describe('log redaction', () => {
  it('drops the query string and fragment, keeps origin and path', () => {
    expect(redactUrl('https://book.swayq.com/manage/abc?token=s3cr3t&x=1#frag')).toBe('https://book.swayq.com/manage/abc?[redacted]')
    expect(redactUrl('https://book.swayq.com/health')).toBe('https://book.swayq.com/health')
  })

  it('never echoes unparseable input', () => {
    expect(redactUrl('not a url ?token=s3cr3t')).toBe('[unparseable url]')
  })

  it('redacts every URL inside an error message', () => {
    const out = redactUrlsIn('fetch failed: https://a.test/cb?code=AAA&state=B then https://b.test/m?token=CCC.')
    expect(out).not.toMatch(/AAA|CCC|state=B/)
    expect(out).toContain('https://a.test/cb?[redacted]')
    expect(out).toContain('https://b.test/m?[redacted]')
  })
})
