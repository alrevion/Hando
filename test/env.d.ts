// Типы для биндингов, доступных тестам через `cloudflare:test`.
// TEST_MIGRATIONS кладётся в изолят из vitest.workers.config.ts и содержит
// реальные миграции из migrations/ — их применяет test/apply-migrations.ts.
import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
