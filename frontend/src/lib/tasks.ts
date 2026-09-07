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
