import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface NavTab {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

/**
 * Плавающая пилюля навигации -- та же, что в Ijoda: стекло с размытием над
 * лентой, скользящая подложка под активной вкладкой.
 *
 * Подложка одна на всю панель, а не своя у каждой кнопки: тогда при
 * переключении она ЕДЕТ от старой вкладки к новой, и глаз видит, откуда и
 * куда ушёл. Ширина слота = (100% - поля) / число вкладок, сдвиг = индекс *
 * 100% собственной ширины; цвет иконки и подложка идут с одной кривой.
 *
 * Не больше пяти вкладок, у каждой иконка И подпись, зона нажатия во всю
 * высоту дока (62px) -- см. index.css .bottom-nav.
 */
export function BottomNav({
  tabs, active, onSelect,
}: { tabs: NavTab[]; active: string; onSelect: (id: string) => void }) {
  const index = Math.max(0, tabs.findIndex((t) => t.id === active));
  return (
    <nav aria-label="Основная навигация" className="bottom-nav" style={{ '--n': tabs.length } as CSSProperties}>
      <div className="nav-indicator" aria-hidden="true" style={{ transform: `translateX(${index * 100}%)` }} />
      {tabs.map((tab, i) => {
        const Icon = tab.icon;
        const on = i === index;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={on ? 'page' : undefined}
            className={on ? 'nav-btn active' : 'nav-btn'}
          >
            <Icon strokeWidth={on ? 2.2 : 1.9} aria-hidden="true" />
            <span className="nav-label">{tab.label}</span>
            {tab.badge ? <span className="nav-badge">{tab.badge > 99 ? '99+' : tab.badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
