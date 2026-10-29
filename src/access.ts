import type { Env } from './types';

/**
 * Hando закрыт: бот и приложение обслуживают только людей с users.allowed = 1
 * (миграции 0037–0038). Остальные -- в том числе ещё не заведённые -- не
 * проходят дальше входа: ни разбора, ни нейросетей, ни регистрации.
 * Закрыто, пока HANDO_CLOSED = '1' (wrangler.jsonc); без неё Hando открыт.
 */
export async function allowed(env: Env, by: 'id' | 'telegram_user_id', key: string | null | undefined): Promise<boolean> {
  if (env.HANDO_CLOSED !== '1') return true;
  if (!key) return false;
  const row = await env.DB.prepare(`SELECT allowed FROM users WHERE ${by} = ?`).bind(key).first<{ allowed: number }>();
  return row?.allowed === 1;
}

export const CLOSED_TEXT = 'Hando сейчас закрыт: им пользуются только приглашённые.';
