/**
 * The `BlobStorage` port over R2: host avatars and team logos.
 *
 * A separate bucket from the `CACHE` KV namespace `Cache`/`BlobCache` share —
 * see the `BlobStorage` doc comment in `ports.ts` for why user-uploaded,
 * authoritative content is a different trust category from freeBusy caching
 * and rendered OG cards, and belongs in durable object storage rather than
 * KV.
 */

import type { BlobStorage } from '../../ports.js'

/**
 * A deployment without the AVATARS binding (the SwayQ fork) gets a storage
 * that reads as empty and refuses writes with a clear error, so the Worker
 * boots and only the upload paths fail.
 */
export function createR2BlobStorage(bucket: R2Bucket | undefined): BlobStorage {
  if (!bucket) {
    return {
      async get() {
        return null
      },
      async put() {
        throw new Error('avatar storage disabled: this deployment has no AVATARS R2 binding')
      },
    }
  }
  return {
    async get(key: string) {
      const obj = await bucket.get(key)
      if (!obj) return null
      const bytes = new Uint8Array(await obj.arrayBuffer())
      return { bytes, contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream' }
    },

    async put(key: string, value: Uint8Array, contentType: string) {
      await bucket.put(key, value, { httpMetadata: { contentType } })
    },
  }
}
