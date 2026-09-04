import type { Task } from '../types';

// todo/in_progress: overdue if the deadline has already passed. done: the
// task is finished, so "overdue" instead asks whether it was finished late
// (done_at past the deadline) -- makes a late finish visible at a glance
// instead of only surfacing it through the separate confirm-time overdue_by.
export function isTaskOverdue(task: Task): boolean {
  if (!task.deadline) return false;
  const deadlineMs = new Date(task.deadline).getTime();
  if (task.status === 'done') return !!task.done_at && new Date(task.done_at).getTime() > deadlineMs;
  if (task.status === 'todo' || task.status === 'in_progress') return deadlineMs < Date.now();
  return false;
}

// Deadline distance in whole days, next to the plain date -- "через 3 дн." /
// "сегодня" / "просрочено на 2 дн.". "дн." sidesteps Russian's day/days/дней
// plural agreement, which isn't worth the grammar table for an internal tool.
export function formatDeadlineDays(deadline: string): string {
  const days = Math.round((new Date(deadline).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'сегодня';
  if (days > 0) return `через ${days} дн.`;
  return `просрочено на ${Math.abs(days)} дн.`;
}

const REVIEW_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

// Done, unconfirmed, and sitting for 2+ days -- that's on the reviewer, not
// the worker (whose own lateness is judged by done_at vs deadline above).
export function isReviewOverdue(task: Task): boolean {
  return task.status === 'done' && !task.confirmed_at && !!task.done_at && Date.now() - new Date(task.done_at).getTime() > REVIEW_WINDOW_MS;
}
