// Медиа из Telegram: что с ним делать и как сохранить.
//
// Виды сообщений и что они означают для поручения:
//   voice       голосовое      -> расшифровка -> разбор
//   video_note  «кружочек»     -> расшифровка (Groq принимает mp4 как есть)
//   audio       аудиофайл      -> расшифровка
//   video       видео          -> расшифровка звуковой дорожки
//   photo       фото           -> вложение; текст берётся из подписи
//   document    любой файл     -> вложение; текст из подписи
//
// Перекодирования нет и не нужно: Groq принимает ogg/opus (голосовые) и mp4
// (кружочки и видео) напрямую. Ffmpeg в воркере не запустить, и это ограничение
// оказалось не помехой, а поводом не тащить лишний слой.
import type { Env } from './types';
import { getFileUrl } from './telegram';

export type MediaKind = 'voice' | 'video_note' | 'audio' | 'video' | 'photo' | 'document';

export type Media = {
  kind: MediaKind;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Есть ли звуковая дорожка -- то есть имеет ли смысл расшифровка. */
  hasAudio: boolean;
};

// Telegram отдаёт боту файлы не больше 20 МБ (getFile). Это же принятый потолок
// вложений (ADR-4), поэтому отдельной константы не заводим -- она уже есть в
// routes.ts, и вторая копия однажды разойдётся с первой.
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

type TgFile = { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
type TgMessage = {
  voice?: TgFile & { duration?: number };
  video_note?: TgFile & { duration?: number };
  audio?: TgFile;
  video?: TgFile;
  document?: TgFile;
  photo?: TgFile[];
  caption?: string;
};

/**
 * Достаёт вложение из сообщения. null -- медиа нет.
 *
 * Фото приходит массивом размеров от мелкого к крупному: берём последний.
 * Мельче -- это превью, и сохранять превью вместо снимка значит потерять
 * оригинал безвозвратно: у бота другого источника нет.
 */
export function extractMedia(msg: TgMessage): Media | null {
  if (msg.voice) {
    return { kind: 'voice', fileId: msg.voice.file_id, filename: 'voice.ogg',
      mimeType: msg.voice.mime_type ?? 'audio/ogg', sizeBytes: msg.voice.file_size ?? 0, hasAudio: true };
  }
  if (msg.video_note) {
    return { kind: 'video_note', fileId: msg.video_note.file_id, filename: 'circle.mp4',
      mimeType: 'video/mp4', sizeBytes: msg.video_note.file_size ?? 0, hasAudio: true };
  }
  if (msg.audio) {
    return { kind: 'audio', fileId: msg.audio.file_id, filename: msg.audio.file_name ?? 'audio.mp3',
      mimeType: msg.audio.mime_type ?? 'audio/mpeg', sizeBytes: msg.audio.file_size ?? 0, hasAudio: true };
  }
  if (msg.video) {
    return { kind: 'video', fileId: msg.video.file_id, filename: msg.video.file_name ?? 'video.mp4',
      mimeType: msg.video.mime_type ?? 'video/mp4', sizeBytes: msg.video.file_size ?? 0, hasAudio: true };
  }
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { kind: 'photo', fileId: largest.file_id, filename: 'photo.jpg',
      mimeType: 'image/jpeg', sizeBytes: largest.file_size ?? 0, hasAudio: false };
  }
  if (msg.document) {
    return { kind: 'document', fileId: msg.document.file_id, filename: msg.document.file_name ?? 'file',
      mimeType: msg.document.mime_type ?? 'application/octet-stream', sizeBytes: msg.document.file_size ?? 0, hasAudio: false };
  }
  return null;
}

/** Скачивает файл для расшифровки. null -- слишком большой или недоступен. */
export async function download(env: Env, media: Media): Promise<Blob | null> {
  if (media.sizeBytes > TELEGRAM_DOWNLOAD_LIMIT) return null;
  try {
    const url = await getFileUrl(env, media.fileId);
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * Кладёт файл в группу-хранилище ПО file_id, без скачивания и перезаливки.
 *
 * file_id действителен для всего бота, а не только для чата, где файл появился,
 * поэтому Telegram копирует его у себя. Для кружочка на 15 МБ это разница между
 * одним запросом и тридцатью мегабайтами трафика через воркер.
 *
 * Отправляем документом независимо от вида: хранилище -- блоб-склад, а не лента.
 * Кружочек, посланный как video_note, нельзя переслать документом обратно.
 */
export async function storeByFileId(env: Env, media: Media): Promise<{ fileId: string; messageId: string } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_STORAGE_CHAT_ID, document: media.fileId }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number; document?: { file_id?: string }; video?: { file_id?: string }; audio?: { file_id?: string } };
    };
    if (!res.ok || !data.ok || !data.result) return null;
    const r = data.result;
    // Telegram сам решает, каким полем вернуть файл: документ, видео или аудио.
    const fileId = r.document?.file_id ?? r.video?.file_id ?? r.audio?.file_id;
    if (!fileId || r.message_id == null) return null;
    return { fileId, messageId: String(r.message_id) };
  } catch {
    return null;
  }
}
