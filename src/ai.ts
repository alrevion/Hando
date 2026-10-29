import type { Env } from './types';

/**
 * Env для запроса от человека: с ключом Groq, только если ему включены
 * нейросети (users.ai_enabled). Каждый вызов Groq уже живёт без ключа --
 * разбор по шаблонам, ассистент без модели, голос не расшифровывается, --
 * поэтому достаточно убрать ключ на входе, а не проверять у каждого вызова.
 */
export async function aiEnv(env: Env, by: 'id' | 'telegram_user_id', key: string | null | undefined): Promise<Env> {
  if (!env.GROQ_API_KEY) return env;
  const row = key
    ? await env.DB.prepare(`SELECT ai_enabled FROM users WHERE ${by} = ?`).bind(key).first<{ ai_enabled: number }>()
    : null;
  return row?.ai_enabled ? env : { ...env, GROQ_API_KEY: '' };
}
