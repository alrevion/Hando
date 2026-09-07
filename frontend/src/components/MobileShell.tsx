import { useEffect, useState } from 'react';
import { CalendarDays, ClipboardList, LayoutGrid, Plus, Send, Users } from 'lucide-react';
import type { Project, Task, User } from '../types';
import { BottomNav, type NavTab } from './BottomNav';
import { ProfileSheet } from './ProfileSheet';
import { CreateSheet } from './CreateSheet';
import { MyTasksView } from './MyTasksView';
import { AssignedView } from './AssignedView';
import { BoardView } from './BoardView';
import { CalendarView } from './CalendarView';
import { PeopleView } from './PeopleView';

/** Инициалы для аватара: «Азиз Каримов» -> «АК». */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/**
 * Мобильная оболочка: одна колонка, стеклянная шапка сверху, плавающая
 * пилюля навигации внизу -- под большим пальцем. Прокручивается только
 * .content, шапка и док лежат поверх (см. index.css .app-frame).
 *
 * Порядок вкладок зависит от роли -- тем же правилом, что в боте: директор
 * приходит смотреть чужой прогресс, сотрудник -- свои задачи. Первой стоит та,
 * ради которой человек открыл приложение. «Люди» -- только руководителям:
 * справочник организации рядовому сотруднику сервер и так не отдаёт.
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
    ...(boss ? [{ id: 'people', label: 'Люди', icon: Users }] : []),
  ];
  const [active, setActive] = useState(tabs[0].id);
  // Профиль и организации -- за аватаром: шестая вкладка в док не влезает, а
  // ходят туда раз в сессию.
  const [profileOpen, setProfileOpen] = useState(false);
  // Быстрое создание -- только там, где оно осмысленно: на поручениях, своих
  // задачах и доске. В календаре и людях создавать нечего.
  const [creating, setCreating] = useState(false);
  // Своя выбранная доска, а не общая с десктопом: на телефоне переключатель --
  // чипы над списком, и он должен работать без похода в App.
  const [projectId, setProjectId] = useState<string | null>(selectedProject?.id ?? null);
  const project = projects.find((p) => p.id === projectId) ?? selectedProject ?? projects[0] ?? null;
  void onReloadProjects;

  // Пришли по ссылке из уведомления -- открываем доску той задачи.
  useEffect(() => {
    if (!deepLinkTask) return;
    setProjectId(deepLinkTask.project_id);
    setActive('board');
  }, [deepLinkTask]);

  const TITLE: Record<string, string> = {
    tasks: 'Мои задачи', assigned: 'Мои поручения', board: 'Доска', calendar: 'Календарь', people: 'Люди',
  };

  const projectChips = projects.length > 1 ? (
    <div className="chips" role="tablist" aria-label="Доски">
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={p.id === project?.id}
          className={p.id === project?.id ? 'chip on' : 'chip'}
          onClick={() => setProjectId(p.id)}
        >
          {p.name}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="topbar-l" aria-hidden="true" />
        <h1 className="topbar-title">{TITLE[active]}</h1>
        {/* Кто я в этой организации. Название самой организации осталось в
            подписи аватара: на 375px оно не помещается рядом с заголовком. */}
        <div className="topbar-r">
          <span className="topbar-role">{user.position || (boss ? 'Руководитель' : 'Сотрудник')}</span>
          <button
            type="button"
            className="avatar"
            style={{ border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            onClick={() => setProfileOpen(true)}
            title={user.org_name ? `${user.name} · ${user.org_name}` : user.name}
            aria-label="Профиль и организации"
          >
            {initials(user.name) || '·'}
          </button>
        </div>
      </header>

      <main className="content">
        {active === 'tasks' ? <MyTasksView user={user} /> : null}
        {active === 'assigned' ? <AssignedView user={user} /> : null}
        {active === 'calendar' ? <CalendarView currentUser={user} /> : null}
        {active === 'people' ? <PeopleView /> : null}
        {active === 'board' ? (
          project ? (
            <BoardView
              key={project.id}
              project={project}
              user={user}
              initialTask={deepLinkTask?.project_id === project.id ? deepLinkTask : null}
              projectSwitcher={projectChips}
            />
          ) : (
            <div className="empty">
              <b>Досок пока нет</b>
              Доска появится, как только в организации создадут первую задачу.
            </div>
          )
        ) : null}
      </main>

      {active === 'tasks' || active === 'assigned' || active === 'board' ? (
        <button
          type="button"
          className="fab"
          aria-label={active === 'tasks' ? 'Новая задача себе' : 'Новое поручение'}
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" />
        </button>
      ) : null}

      <BottomNav tabs={tabs} active={active} onSelect={setActive} />

      {creating ? (
        <CreateSheet mode={active === 'tasks' ? 'mine' : 'assigned'} me={user} onClose={() => setCreating(false)} />
      ) : null}

      {profileOpen ? <ProfileSheet user={user} onClose={() => setProfileOpen(false)} /> : null}
    </div>
  );
}
