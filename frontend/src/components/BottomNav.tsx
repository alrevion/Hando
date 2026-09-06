import type { LucideIcon } from 'lucide-react';

export interface NavTab {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

/**
 * Нижняя навигация -- основная на телефоне.
 *
 * Почему не боковая панель: в Telegram приложение открывается на пол-экрана,
 * и панель слева съедает треть ширины под то, чем пользуются раз в сессию.
 * Внизу до кнопок дотягивается большой палец -- туда и вынесено главное.
 *
 * Правила, которые здесь соблюдены осознанно:
 *   -- не больше пяти вкладок (больше не помещается читаемо);
 *   -- иконка И подпись: одна иконка без подписи угадывается неверно;
 *   -- зона нажатия не меньше 44pt по высоте;
 *   -- отступ снизу под жестовую полосу iPhone (safe-area).
 */
export function BottomNav({
  tabs, active, onSelect,
}: { tabs: NavTab[]; active: string; onSelect: (id: string) => void }) {
  return (
    <nav
      aria-label="Основная навигация"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--tg-separator,rgba(0,0,0,0.08))] bg-[var(--tg-bg,#fff)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-lg">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const on = tab.id === active;
          return (
            <li key={tab.id} className="flex-1">
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                aria-current={on ? 'page' : undefined}
                className={`relative flex h-14 w-full flex-col items-center justify-center gap-0.5 transition-colors ${
                  on ? 'text-[var(--tg-link,#2563eb)]' : 'text-[var(--tg-hint,#64748b)]'
                }`}
              >
                <span className="relative">
                  <Icon className="h-5 w-5" strokeWidth={on ? 2.4 : 1.8} aria-hidden="true" />
                  {tab.badge ? (
                    <span className="absolute -right-2 -top-1 min-w-4 rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-4 text-white">
                      {tab.badge > 99 ? '99+' : tab.badge}
                    </span>
                  ) : null}
                </span>
                <span className="text-[11px] font-medium leading-none">{tab.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
