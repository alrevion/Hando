// Применяет реальные миграции к тестовой D1 перед каждым файлом тестов.
// Схема в тестах = схема в проде: migrations_dir один и тот же.
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
