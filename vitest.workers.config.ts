// Тесты идут против НАСТОЯЩЕЙ D1 в workerd, а не против подделки.
// Причина в плане (шаг -1): прежний fakeDB диспетчеризовал по регулярке на тексте
// SQL, поэтому условие `AND org_id = ?` было для него невидимо -- как и его
// отсутствие. Тест изоляции на таком харнессе зелёный на дырявом проде.
import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  // Миграции читаются из того же каталога, что использует wrangler, -- чтобы
  // тестовая схема не могла разойтись с продовой.
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));

  return {
    test: {
      name: 'workers',
      // mcp.test.ts идёт в node-пуле: он импортирует src/index -> src/mcp ->
      // @modelcontextprotocol/sdk -> ajv, а ajv грузит .json как модуль, чего
      // workerd не умеет. См. vitest.node.config.ts.
      include: ['test/access.test.ts', 'test/schema.test.ts', 'test/regression.test.ts', 'test/step0.test.ts', 'test/step1.test.ts', 'test/single-writer.test.ts', 'test/step2a.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          // wrangler.configPath здесь НЕ используется намеренно: он подтянул бы
          // `main: src/index.ts`, а тот импортирует mcp.ts со всем SDK -- и
          // изолят падал бы на ajv ещё до первого теста. Тестам точка входа не
          // нужна: они импортируют apiRoutes и env.DB напрямую.
          // Цена -- compatibility_date/flags продублированы из wrangler.jsonc;
          // при их изменении править оба места.
          miniflare: {
            compatibilityDate: '2025-01-01',
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: ['DB'],
            // Список миграций уезжает в изолят биндингом; применяет их
            // setupFile перед каждым файлом тестов.
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
