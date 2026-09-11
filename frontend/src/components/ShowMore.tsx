import { useEffect, useState, type ReactNode } from 'react';

/** По сколько строк показываем за раз -- столько же, сколько бот шлёт в списке. */
export const PAGE = 10;

/**
 * Длинный список порциями.
 *
 * Причина не в сети -- данные и так уже в складе, -- а в отрисовке: сотня
 * карточек со сроками и метками заставляет экран думать на каждом открытии
 * вкладки. Плюс глазу: десять строк читаются, сотня -- пролистывается.
 *
 * `resetOn` возвращает счётчик к первой порции, когда список сменился целиком
 * (выбрали другой день в календаре, переключили этап): иначе на новом списке
 * осталась бы прокрутка от предыдущего.
 */
export function usePaging(resetOn?: unknown): { shown: number; more: () => void } {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [resetOn]);
  return { shown, more: () => setShown((n) => n + PAGE) };
}

/** Кнопка «Показать ещё» -- рисуется, только когда есть что показывать. */
export function ShowMore({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }): ReactNode {
  if (total <= shown) return null;
  return (
    <button type="button" className="btn" style={{ marginTop: 12 }} onClick={onMore}>
      Показать ещё · осталось {total - shown}
    </button>
  );
}
