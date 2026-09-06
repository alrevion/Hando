import { useState } from 'react';
import { CalendarDays, ClipboardList, LayoutGrid, Send, User as UserIcon } from 'lucide-react';
import type { Project, Task, User } from '../types';
import { BottomNav, type NavTab } from './BottomNav';
import { MyTasksView } from './MyTasksView';
import { AssignedView } from './AssignedView';
import { BoardView } from './BoardView';
import { CalendarView } from './CalendarView';
import { PeopleView } from './PeopleView';

/**
 * Мобильная оболочка приложения.
 *
 * Прежде на телефоне открывалась десктопная раскладка: боковая панель на треть
 * экрана и доска в остатке. В Telegram приложение и так на пол-экрана, поэтому
 * здесь колонка во всю ширину, а навигация -- внизу, под большим пальцем.
 *
 * Порядок вкладок зависит от роли -- тем же правилом, что в боте: директор
 * приходит смотреть чужой прогресс, сотрудник -- свои задачи. Первой стоит та,
 * ради которой человек открыл приложение.
 */
export function MobileShell({
  user, projects, selectedProject, deepLinkTask, onReloadProjects,
}: {
  user: User;
  projects: Project[];
  selectedProject: Project | null;
  deepLinkTask: Task | null;
  onReloadProjects: () => void;
}) {
  const boss = user.role === 'creator' || user.role === 'super_admin';
  const tabs: NavTab[] = [
    ...(boss
      ? [
          { id: 'assigned', label: 'Поручения', icon: Send },
          { id: 'tasks', label: 'Мои задачи', icon: ClipboardList },
        ]
      : [
          { id: 'tasks', label: 'Мои задачи', icon: ClipboardList },
          { id: 'assigned', label: 'Поручения', icon: Send },
        ]),
    { id: 'board', label: 'Доска', icon: LayoutGrid },
    { id: 'calendar', label: 'Календарь', icon: CalendarDays },
    { id: 'people', label: 'Люди', icon: UserIcon },
  ];
  const [active, setActive] = useState(tabs[0].id);
  void onReloadProjects;

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--tg-bg,#f1f5f9)]">
      {/* Шапка: где человек находится. Без неё при переключении организаций
          непонятно, чьи задачи на экране. */}
      <header
        className="sticky top-0 z-30 border-b border-[var(--tg-separator,rgba(0,0,0,0.08))] bg-[var(--tg-bg,#fff)] px-4 py-2.5"
        style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
      >
        <p className="truncate text-sm font-semibold text-[var(--tg-text,#0f172a)]">{user.org_name ?? 'Hando'}</p>
        <p className="truncate text-xs text-[var(--tg-hint,#64748b)]">{user.name}</p>
      </header>

      {/* Отступ снизу под навигацию: без него последняя карточка прячется за ней. */}
      <main className="min-h-0 flex-1 pb-16">
        {active === 'tasks' ? <MyTasksView user={user} /> : null}
        {active === 'assigned' ? <AssignedView user={user} /> : null}
        {active === 'calendar' ? <CalendarView currentUser={user} /> : null}
        {active === 'people' ? <PeopleView /> : null}
        {active === 'board' ? (
          selectedProject ? (
            <BoardView
              key={selectedProject.id}
              project={selectedProject}
              user={user}
              initialTask={deepLinkTask?.project_id === selectedProject.id ? deepLinkTask : null}
            />
          ) : (
            <div className="p-6 text-center text-sm text-[var(--tg-hint,#64748b)]">
              {projects.length === 0 ? 'Досок пока нет.' : 'Выберите доску.'}
            </div>
          )
        ) : null}
      </main>

      <BottomNav tabs={tabs} active={active} onSelect={setActive} />
    </div>
  );
}
