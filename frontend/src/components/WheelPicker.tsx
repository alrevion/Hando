import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface WheelPickerProps<T extends string | number> {
  items: T[];
  value: T;
  onChange: (value: T) => void;
  formatItem?: (item: T) => string;
  itemHeight?: number;
  /** number of visible rows (odd, so one row sits exactly centered) */
  visibleCount?: number;
  /** infinite cyclic scroll (e.g. hours 00-23 wrapping past midnight) instead of a bounded list */
  loop?: boolean;
  className?: string;
}

const DEFAULT_ITEM_H = 40;
const DEFAULT_VISIBLE = 3;
const SETTLE_MS = 140;
/** repeats of the value set rendered in loop mode, so the user can keep
 * scrolling past either end without ever reaching a real DOM boundary */
const LOOP_COUNT = 5;

/**
 * iOS-style scrollable wheel column (scroll-snap-like + a fixed center
 * highlight band), used for time/duration selection. Modeled after the wheel
 * picker in Ijoda, перенесённое сюда как есть: механика прокрутки со снапом,
 * бесконечной прокруткой и перетаскиванием мышью уже отлажена там, и вторая
 * её реализация разошлась бы с первой на первой же правке.
 */
export function WheelPicker<T extends string | number>({
  items,
  value,
  onChange,
  formatItem,
  itemHeight = DEFAULT_ITEM_H,
  visibleCount = DEFAULT_VISIBLE,
  loop = false,
  className = '',
}: WheelPickerProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const segmentLen = items.length;
  const renderCount = loop ? segmentLen * LOOP_COUNT : segmentLen;
  const midSegment = Math.floor(LOOP_COUNT / 2);
  const segPx = segmentLen * itemHeight;

  const clampIdx = (idx: number) => Math.min(renderCount - 1, Math.max(0, idx));
  const rowValue = (globalIdx: number) =>
    items[((globalIdx % segmentLen) + segmentLen) % segmentLen];

  function initialIdx() {
    const v = items.indexOf(value);
    const base = v < 0 ? 0 : v;
    return loop ? midSegment * segmentLen + base : base;
  }

  const [activeIndex, setActiveIndex] = useState(initialIdx);

  const containerH = itemHeight * visibleCount;
  const padY = (containerH - itemHeight) / 2;

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const idx = initialIdx();
    setActiveIndex(idx);
    el.scrollTop = idx * itemHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** In loop mode, once scroll nears either end of the repeated buffer,
   * silently jump two segments back toward the middle (same displayed
   * value, so the recenter is invisible) — lets the user keep scrolling
   * past the "edge" without ever hitting a real boundary. */
  function recenter(el: HTMLDivElement, idx: number): number {
    if (!loop) return idx;
    if (idx < segmentLen) {
      el.scrollTop += 2 * segPx;
      return idx + 2 * segmentLen;
    }
    if (idx >= renderCount - segmentLen) {
      el.scrollTop -= 2 * segPx;
      return idx - 2 * segmentLen;
    }
    return idx;
  }

  function handleScroll() {
    const el = trackRef.current;
    if (!el) return;
    const idx = recenter(el, clampIdx(Math.round(el.scrollTop / itemHeight)));
    setActiveIndex(idx);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      const settled = trackRef.current;
      if (!settled) return;
      const finalIdx = clampIdx(Math.round(settled.scrollTop / itemHeight));
      setActiveIndex(finalIdx);
      const v = rowValue(finalIdx);
      if (v !== value) onChange(v);
    }, SETTLE_MS);
  }

  /**
   * Перетаскивание мышью.
   *
   * Колесо задумано под палец: на телефоне список крутят свайпом. На
   * компьютере свайпа нет — остаётся колёсико мыши, а им попасть в нужный час
   * из двадцати четырёх неудобно. Поэтому здесь ручное перетаскивание:
   * зажал — потянул. Тач не трогаем, там работает родная инерция браузера,
   * и перехватывать её вручную значило бы её испортить.
   */
  const drag = useRef<{ y: number; top: number } | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'touch') return;
    const el = trackRef.current;
    if (!el) return;
    // Без этого браузер параллельно с захватом указателя пытался начать
    // выделение текста строк — оба обработчика тянули scrollTop/выделение
    // каждый в свою сторону, и перетаскивание читалось как не работающее.
    e.preventDefault();
    drag.current = { y: e.clientY, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const el = trackRef.current;
    if (!el || !drag.current) return;
    e.preventDefault();
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const el = trackRef.current;
    if (!el || !drag.current) return;
    drag.current = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    // Доводим до ближайшей строки: после перетаскивания список почти всегда
    // стоит между позициями, и без доводки подсветка не совпадает со строкой.
    const idx = clampIdx(Math.round(el.scrollTop / itemHeight));
    el.scrollTo({ top: idx * itemHeight, behavior: 'smooth' });
  }

  function selectIndex(idx: number) {
    const el = trackRef.current;
    if (el) el.scrollTo({ top: idx * itemHeight, behavior: 'smooth' });
    setActiveIndex(idx);
    onChange(rowValue(idx));
  }

  return (
    <div className={['wheel-picker', className].filter(Boolean).join(' ')} style={{ height: containerH }}>
      <div className='wheel-picker-highlight' style={{ height: itemHeight }} />
      <div
        ref={trackRef}
        className='wheel-picker-track'
        onScroll={handleScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ paddingTop: padY, paddingBottom: padY }}
      >
        {Array.from({ length: renderCount }, (_, idx) => (
          <div
            key={idx}
            className={['wheel-picker-item', idx === activeIndex ? "active" : '']
              .filter(Boolean)
              .join(' ')}
            style={{ height: itemHeight }}
            onClick={() => {
              if (!drag.current) selectIndex(idx);
            }}
          >
            {formatItem ? formatItem(rowValue(idx)) : String(rowValue(idx))}
          </div>
        ))}
      </div>
    </div>
  );
}
