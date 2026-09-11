// Смысловая память ответов помощника.
//
// Эмбеддер живёт НЕ здесь: он стоит контейнером на Ampere рядом с Evi и
// отвечает по HTTP. Worker считать векторы не умеет и не должен -- в изоляте
// нет места модели на 120 МБ.
//
// Всё в этом файле обязано ПАДАТЬ МЯГКО. Эмбеддер -- ускоритель, а не
// зависимость: сервер недоступен, токен протух, ответ не пришёл за две
// секунды -- помощник просто отвечает моделью, как отвечал всегда.
import type { Env } from './types';
import { nowIso, uuid } from './db';

const TIMEOUT_MS = 2500;
/**
 * Порог косинуса -- 0.93, и он выбран замером, а не на глаз (11 сентября, девять
 * живых вопросов по продукту, MiniLM на Ampere):
 *
 *   «отметить выполненную» ~ «где нажать что готова»   0.948  одно и то же
 *   «пригласить сотрудника» ~ «добавить человека»      0.863  одно и то же
 *   «отметить выполненную» ~ «что делать если не успею» 0.884  РАЗНОЕ
 *   «отметить выполненную» ~ «удалить организацию»      0.642  РАЗНОЕ
 *
 * Классы НАКЛАДЫВАЮТСЯ: самый дальний перефраз (0.863) ниже самого близкого
 * чужого вопроса (0.884). Значит порога, который поймает все перефразы и не
 * поймает ни одного чужого, не существует -- ни у MiniLM, ни у mpnet (у той
 * разделение ещё хуже: 0.658 против 0.807).
 *
 * Выбор сделан в сторону молчания: 0.93 пропускает только близкие
 * переформулировки и оставляет запас 0.046 до ближайшего чужого вопроса.
 * Память срабатывает реже, зато не отвечает на вопрос, которого не задавали.
 */
const THRESHOLD = 0.93;
/** Сколько строк держим в памяти изолята, чтобы не читать D1 на каждый вопрос. */
const MEMO_MS = 5 * 60 * 1000;

type Row = { id: string; vector: unknown; answer: string; model: string };

/**
 * BLOB из D1 приходит то как ArrayBuffer, то как массив байтов -- зависит от
 * версии драйвера. Разбирать обе формы дешевле, чем ловить молчаливый промах
 * памяти: неверно собранный вектор не падает, он просто никогда не совпадает.
 */
function toVector(raw: unknown): Float32Array | null {
  if (raw instanceof ArrayBuffer) return new Float32Array(raw);
  if (ArrayBuffer.isView(raw)) return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (Array.isArray(raw)) return new Float32Array(Uint8Array.from(raw as number[]).buffer);
  return null;
}
let memo: { at: number; model: string; rows: { id: string; v: Float32Array; answer: string }[] } | null = null;

/** Вектор фразы. null -- эмбеддер недоступен; это не ошибка, а обычный день. */
export async function embed(env: Env, text: string): Promise<{ v: Float32Array; model: string } | null> {
  if (!env.EMBED_URL) return null;
  try {
    const res = await fetch(`${env.EMBED_URL.replace(/\/+$/, '')}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.EMBED_TOKEN ? { Authorization: `Bearer ${env.EMBED_TOKEN}` } : {}),
      },
      body: JSON.stringify({ texts: [text.slice(0, 500)] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { model?: string; vectors?: number[][] };
    const first = data.vectors?.[0];
    if (!first?.length || !data.model) return null;
    return { v: Float32Array.from(first), model: data.model };
  } catch {
    return null;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : -1;
}

/** Строки одной модели. Изолят живёт между запросами, поэтому D1 читается редко. */
async function load(env: Env, model: string): Promise<{ id: string; v: Float32Array; answer: string }[]> {
  if (memo && memo.model === model && Date.now() - memo.at < MEMO_MS) return memo.rows;
  const { results } = await env.DB.prepare('SELECT id, vector, answer, model FROM answer_cache WHERE model = ? LIMIT 500')
    .bind(model).all<Row>();
  const rows = results
    .map((r) => ({ id: r.id, v: toVector(r.vector), answer: r.answer }))
    .filter((r): r is { id: string; v: Float32Array; answer: string } => r.v !== null);
  memo = { at: Date.now(), model, rows };
  return rows;
}

/** Готовый ответ на такой же по смыслу вопрос. null -- надо спрашивать модель. */
export async function recallAnswer(env: Env, question: string): Promise<string | null> {
  const q = await embed(env, question);
  if (!q) return null;
  const rows = await load(env, q.model);
  let best: { id: string; answer: string; score: number } | null = null;
  for (const row of rows) {
    const score = cosine(q.v, row.v);
    if (!best || score > best.score) best = { id: row.id, answer: row.answer, score };
  }
  if (!best || best.score < THRESHOLD) return null;
  await env.DB.prepare('UPDATE answer_cache SET hits = hits + 1 WHERE id = ?').bind(best.id).run().catch(() => undefined);
  return best.answer;
}

/** Кладёт ответ в память. Зовётся только для общих ответов -- проверку делает вызывающий. */
export async function rememberAnswer(env: Env, question: string, answer: string): Promise<void> {
  const q = await embed(env, question);
  if (!q) return;
  await env.DB.prepare('INSERT INTO answer_cache (id, vector, answer, model, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(uuid(), q.v.buffer, answer, q.model, nowIso()).run().catch(() => undefined);
  memo = null; // следующий вопрос перечитает: иначе свежий ответ ждал бы пять минут
}
