import type { Priority } from '../types';

export const PRIORITIES: { value: Priority; label: string; dot: string }[] = [
  { value: 'urgent', label: 'Высокая', dot: 'bg-red-500' },
  { value: 'medium', label: 'Средняя', dot: 'bg-amber-500' },
  { value: 'low', label: 'Низкая', dot: 'bg-slate-400' },
];

export const PRIORITY_LABEL: Record<Priority, string> = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label])) as Record<Priority, string>;
export const PRIORITY_DOT: Record<Priority, string> = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.dot])) as Record<Priority, string>;
