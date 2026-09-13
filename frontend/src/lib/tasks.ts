// Помощники по адресатам задачи.
//
// До contract-релиза шага 3 «кто делает» было одной колонкой, и фронт всюду
// сравнивал с ней. Теперь это список строк -- по одной на человека, с
// собственным состоянием. Эти функции держат перевод в одном месте, чтобы
// девять экранов не считали его каждый по-своему.
import type { Assignee, Task } from '../types';

/** Моя строка в задаче. undefined -- я не адресат. */
export function myRow(task: Task, userId: string): Assignee | undefined {
  return task.assignees?.find((a) => a.user_id === userId);
}

export function isMine(task: Task, userId: string): boolean {
  return Boolean(myRow(task, userId));
}

/** Кого показывать на карточке: один человек или «Азиз и ещё 13». */
export function assigneeLabel(task: Task): string {
  const list = task.assignees ?? [];
  if (list.length === 0) return 'без адресата';
  if (list.length === 1) return list[0].user_name;
  return `${list[0].user_name} и ещё ${list.length - 1}`;
}

/** Цвет-плашка по первому адресату: раньше ключом был responsible_user_id. */
export function assigneeKey(task: Task): string {
  return task.assignees?.[0]?.user_id ?? task.id;
}

/**
 * Этап строки: «принято» и «в работе» -- это одно состояние accepted, их
 * разделяет started_at. Здесь единственное место перевода, чтобы девять
 * экранов не считали его каждый по-своему.
 */
export type Stage = 'pending' | 'accepted' | 'started' | 'done' | 'other';

export function stageOf(a: Assignee | undefined): Stage {
  if (!a) return 'other';
  if (a.state === 'pending') return 'pending';
  if (a.state === 'accepted' || a.state === 'rejected') return a.started_at ? 'started' : 'accepted';
  if (a.state === 'done') return 'done';
  return 'other';
}

/** Начал ли кто-то из адресатов -- для этапа глазами автора. */
export function anyStarted(task: Task): boolean {
  return (task.assignees ?? []).some((a) => (a.state === 'accepted' || a.state === 'rejected') && !!a.started_at);
}

const STATE_LABEL: Record<Assignee['state'], string> = {
  pending: 'не принял',
  accepted: 'в работе',
  done: 'сдал',
  confirmed: 'принято',
  rejected: 'вернули',
  declined: 'отказался',
};

export function stateLabel(state: Assignee['state']): string {
  return STATE_LABEL[state] ?? state;
}

/** Тон плашки по состоянию адресата: серый -- ещё ничего, синий -- делает,
 *  зелёный -- сдал/принято, оранжевый -- вернули, красный -- отказался. */
export const STATE_PILL: Record<Assignee['state'], string> = {
  pending: 'pill',
  accepted: 'pill pill-blue',
  done: 'pill pill-green',
  confirmed: 'pill pill-green',
  rejected: 'pill pill-orange',
  declined: 'pill pill-red',
};

/** Пункты списка задачи. Битый JSON -- пустой список, а не белый экран. */
export function checklistOf(task: Task): { t: string; d: string | null }[] {
  if (!task.checklist) return [];
  try {
    const v = JSON.parse(task.checklist) as unknown;
    return Array.isArray(v) ? v.filter((x): x is { t: string; d: string | null } => !!x && typeof (x as { t: unknown }).t === 'string') : [];
  } catch { return []; }
}

/** Повтор словами: хранится МИНУТАМИ, читать его так никто не станет. */
export function repeatLabel(min: number | null): string {
  if (!min) return 'Нет';
  if (min % 1440 === 0) {
    const d = min / 1440;
    if (d === 1) return 'Каждый день';
    if (d === 2) return 'Через день';
    if (d === 7) return 'Каждую неделю';
    if (d === 30) return 'Каждый месяц';
    return `Каждые ${d} дн.`;
  }
  if (min % 60 === 0) return `Каждые ${min / 60} ч`;
  if (min < 60) return `Каждые ${min} мин`;
  return `Каждые ${Math.floor(min / 60)} ч ${min % 60} мин`;
}

/** Готовые интервалы в минутах. Всё остальное -- через «Свой». */
export const REPEAT_CHOICES = [0, 1440, 2880, 10080, 43200];
