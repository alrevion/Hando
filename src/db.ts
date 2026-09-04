// Thin D1 helpers. Deliberately tiny — no query builder.
import type { Env, TaskEvent } from './types';

export const uuid = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

type EventInput = {
  actorId: string | null; // null = system-generated (e.g. auto-archive)
  targetType: TaskEvent['target_type'];
  targetId: string;
  action: string;
  comment?: string | null;
  overdueBy?: number | null;
};

// events is the append-only system of record for "who did what".
export async function logEvent(db: Env['DB'], e: EventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (id, actor_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(uuid(), e.actorId, e.targetType, e.targetId, e.action, e.comment ?? null, e.overdueBy ?? null, nowIso())
    .run();
}
