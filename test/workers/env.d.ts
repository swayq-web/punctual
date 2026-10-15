/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import type { Env as WorkerEnv } from '../../src/index.js'

// The pool types `env` as `Cloudflare.Env`, so the Worker's own bindings plus
// the config-time migrations are merged into that global namespace.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // Optional in production (the SwayQ fork omits it); the test config binds it.
      AVATARS: R2Bucket
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
