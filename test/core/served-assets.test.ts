/**
 * What the `[assets]` binding serves. Cloudflare answers these files before
 * the Worker runs, so no route or switch can hide one: a file is either
 * uploaded or listed in `assets/.assetsignore`.
 *
 * Only the fonts are served. The upstream product images (`assets/brand/`,
 * `assets/og/`) stay in the repository, so the fork merges cleanly, and are
 * never uploaded. A new directory under `assets/` fails here until it is
 * either ignored or added to `SERVED_DIRS` on purpose.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ASSETS = path.join(import.meta.dirname, '../../assets')
const SERVED_DIRS = ['fonts']

const rules = readFileSync(path.join(ASSETS, '.assetsignore'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel]
  })
}

/** Every file wrangler uploads: all of `assets/`, minus the ignore file and what it lists. */
const served = walk(ASSETS).filter(
  (file) => file !== '.assetsignore' && !rules.some((rule) => file.startsWith(rule)),
)

describe('static assets', () => {
  it('the ignore file holds only whole top-level directories, so the check below reads it exactly as wrangler does', () => {
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(rule).toMatch(/^[a-z0-9-]+\/$/)
  })

  it('serves the fonts and nothing else', () => {
    expect(served.length).toBeGreaterThan(0)
    for (const file of served) expect(SERVED_DIRS).toContain(file.split('/')[0])
  })

  it.each([
    'brand/social-preview.png',
    'brand/screenshot-booking.png',
    'brand/wordmark-dark.svg',
    'brand/wordmark-light.svg',
    'brand/avatar.png',
    'og/default.png',
  ])('does not serve the upstream image %s', (file) => {
    expect(served).not.toContain(file)
  })

  it('names nothing upstream in a served file name', () => {
    for (const file of served) expect(file).not.toMatch(/punctual|github/i)
  })
})
