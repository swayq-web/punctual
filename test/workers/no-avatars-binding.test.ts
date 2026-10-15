import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createR2BlobStorage } from '../../src/adapters/storage/r2-blob.js'

describe('a deployment without the AVATARS R2 binding', () => {
  it('builds ports and serves /health', async () => {
    const { default: worker } = await import('../../src/index.js')
    const noAvatars = { ...env, AVATARS: undefined }
    const res = await worker.fetch(
      new Request('https://punctual.test/health'),
      noAvatars as unknown as typeof env,
      createExecutionContext(),
    )
    expect(res.status).toBe(200)
  })

  it('reads as not found and refuses writes with a clear error', async () => {
    const storage = createR2BlobStorage(undefined)
    expect(await storage.get('avatars/x')).toBeNull()
    await expect(storage.put('avatars/x', new Uint8Array([1]), 'image/png')).rejects.toThrow(
      /avatar storage disabled/,
    )
  })
})
