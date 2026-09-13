import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { pushBack } from '../lib/telegram';

/** За сколько пикселей протяжки шторка считается закрытой. */
const CLOSE_AT = 90;
/** Столько же, сколько длится переход ухода в CSS. */
const LEAVE_MS = 220;

/**
 * Шторка снизу. Рисуется ПОРТАЛОМ в body, а не там, где написана.
 *
 * Причина: экраны живут внутри прокручиваемого .content, а плавающий док --
 * сосед этого контейнера. Из-за прокрутки и обрезки содержимого шторка
 * оказывалась под доком, и её нижняя часть (как раз кнопки действий) пряталась
 * за меню навигации. Портал уносит её на верхний уровень, где z-index работает
 * без оговорок.
 *
 * Шапку -- полоску, заголовок и крестик -- рисует САМА шторка, а не каждый
 * вызов по отдельности. Так она может: держать её приклеенной при прокрутке
 * (крестик нужен всегда, а не только в начале списка), закрывать себя
 * протяжкой за полоску и проигрывать уход, а не исчезать кадром.
 *
 * Пока шторка открыта, страница под ней не прокручивается: иначе палец на
 * фоне уводит ленту, а модальное окно остаётся висеть.
 */
export function Sheet({
  title, onClose, children,
}: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  // Уход -- отдельное состояние: закрыть просят четырьмя способами (крестик,
  // фон, Escape, системная «назад», протяжка), а переход должен быть один.
  const [leaving, setLeaving] = useState(false);
  const [pulled, setPulled] = useState(0);
  const from = useRef<number | null>(null);

  const close = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    // Системная «назад» на Android закрывает шторку, а не всё приложение.
    const unback = pushBack(close);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
      unback();
    };
  }, [close]);

  // Размонтирует шторку РОДИТЕЛЬ, поэтому ждём конец перехода по таймеру, а не
  // по animationend: при «уменьшить движение» переход не играет вовсе, и
  // событие не пришло бы никогда -- шторка осталась бы висеть.
  useEffect(() => {
    if (!leaving) return undefined;
    const t = setTimeout(onClose, LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving, onClose]);

  const dragging = from.current !== null;
  const style = leaving
    ? { transform: 'translateY(100%)' }
    : pulled > 0
      ? { transform: `translateY(${pulled}px)`, transition: dragging ? 'none' : undefined }
      : undefined;

  return createPortal(
    <div className={leaving ? 'sheet-backdrop is-leaving' : 'sheet-backdrop'} onClick={close}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="sheet" style={style} onClick={(e) => e.stopPropagation()}>
        {/* Вся верхняя полоса -- ручка: полоска шириной 36px под палец не
            попадает, а тянут шторку именно за «шапку», как в системных. */}
        <div className="sheet-top"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            from.current = e.clientY;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (from.current === null) return;
            setPulled(Math.max(0, e.clientY - from.current));
          }}
          onPointerUp={() => {
            if (from.current === null) return;
            from.current = null;
            if (pulled > CLOSE_AT) close(); else setPulled(0);
          }}
          onPointerCancel={() => { from.current = null; setPulled(0); }}>
          <div className="sheet-grab" aria-hidden="true" />
          <div className="sheet-head">
            <h2 id={titleId} className="sheet-title">{title}</h2>
            <button type="button" className="btn-icon" aria-label="Закрыть" onClick={close}>
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
