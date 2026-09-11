import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pushBack } from '../lib/telegram';

/**
 * Шторка снизу. Рисуется ПОРТАЛОМ в body, а не там, где написана.
 *
 * Причина: экраны живут внутри прокручиваемого .content, а плавающий док --
 * сосед этого контейнера. Из-за прокрутки и обрезки содержимого шторка
 * оказывалась под доком, и её нижняя часть (как раз кнопки действий) пряталась
 * за меню навигации. Портал уносит её на верхний уровень, где z-index работает
 * без оговорок.
 *
 * Пока шторка открыта, страница под ней не прокручивается: иначе палец на
 * фоне уводит ленту, а модальное окно остаётся висеть.
 */
export function Sheet({
  labelledBy, onClose, children,
}: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Системная «назад» на Android закрывает шторку, а не всё приложение.
    const unback = pushBack(onClose);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
      unback();
    };
  }, [onClose]);

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body,
  );
}
