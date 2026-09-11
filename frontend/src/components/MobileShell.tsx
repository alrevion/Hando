import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ClipboardList, MoreHorizontal, Plus, Send } from 'lucide-react';
import type { Task, User } from '../types';
import { BottomNav, type NavTab } from './BottomNav';
import { ProfileSheet } from './ProfileSheet';
import { CreateSheet } from './CreateSheet';
import { MyTasksView } from './MyTasksView';
import { AssignedView } from './AssignedView';
import { CalendarView } from './CalendarView';
import { PeopleView } from './PeopleView';
import { MoreView, type MoreSub } from './MoreView';
import { OrgView } from './OrgView';
import { DraftsView } from './DraftsView';
import { AllTasksView } from './AllTasksView';
import { NotifyView } from './NotifyView';
import { AskView } from './AskView';
import { TaskDetailModal } from './TaskDetailModal';
import { TipsCard } from './TipsCard';

/** Инициалы для аватара: «Азиз Каримов» -> «АК». */
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

const ROLE_LABEL: Record<string, string> = { creator: 'Владелец', super_admin: 'Руководитель', admin: 'Руководитель отдела', member: 'Участник' };
const SUB_TITLE: Record<MoreSub, string> = { people: 'Люди', org: 'Организация', drafts: 'Черновики', all: 'Все задания', notify: 'Уведомления', ask: 'Вопрос' };

/**
 * Мобильная оболочка: четыре вкладки (раздел 22) -- Поручения · Задачи
 * (порядок по роли) · Календарь · Ещё. «Доска» ушла: этапы живут прямо в
 * списках. Внутри «Ещё» -- подэкраны с кнопкой «назад» в шапке.
 */
export function MobileShell({ user, deepLinkTask }: { user: User; deepLinkTask: Task | null }) {
  const boss = user.role !== 'member';
  const tabs: NavTab[] = [
    ...(boss
      ? [{ id: 'assigned', label: 'Поручения', icon: Send }, { id: 'tasks', label: 'Задачи', icon: ClipboardList }]
      : [{ id: 'tasks', label: 'Задачи', icon: ClipboardList }, { id: 'assigned', label: 'Поручения', icon: Send }]),
    { id: 'calendar', label: 'Календарь', icon: CalendarDays },
    { id: 'more', label: 'Ещё', icon: MoreHorizontal },
  ];
  const [active, setActive] = useState(tabs[0].id);
  const [sub, setSub] = useState<MoreSub | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [linked, setLinked] = useState<Task | null>(null);

  // Пришли по ссылке из уведомления -- открываем саму задачу.
  useEffect(() => { if (deepLinkTask) setLinked(deepLinkTask); }, [deepLinkTask]);

  const TITLE: Record<string, string> = { tasks: 'Мои задачи', assigned: 'Мои поручения', calendar: 'Календарь', more: 'Ещё' };
  const title = active === 'more' && sub ? SUB_TITLE[sub] : TITLE[active];

  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="topbar-l">
          {active === 'more' && sub ? (
            <button type="button" className="btn-icon" aria-label="Назад" onClick={() => setSub(null)}><ChevronLeft aria-hidden="true" /></button>
          ) : null}
        </div>
        <h1 className="topbar-title">{title}</h1>
        <div className="topbar-r">
          <span className="topbar-role">{user.position || ROLE_LABEL[user.role] || ''}</span>
          <button type="button" className="avatar" style={{ border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            onClick={() => setProfileOpen(true)} title={user.org_name ? `${user.name} · ${user.org_name}` : user.name} aria-label="Профиль и организации">
            {initials(user.name) || '·'}
          </button>
        </div>
      </header>

      <main className="content">
        {active === 'tasks' ? <><TipsCard screen="tasks" /><MyTasksView user={user} /></> : null}
        {active === 'assigned' ? <><TipsCard screen="assigned" /><AssignedView user={user} /></> : null}
        {active === 'calendar' ? <CalendarView currentUser={user} /> : null}
        {active === 'more' ? (
          sub === null ? <MoreView user={user} onOpen={setSub} onProfile={() => setProfileOpen(true)} />
          : sub === 'people' ? <PeopleView />
          : sub === 'org' ? <OrgView user={user} />
          : sub === 'drafts' ? <DraftsView me={user} />
          : sub === 'all' ? <AllTasksView />
          : sub === 'notify' ? <NotifyView user={user} />
          : <AskView />
        ) : null}
      </main>

      {active === 'tasks' || active === 'assigned' ? (
        <button type="button" className="fab" aria-label={active === 'tasks' ? 'Новая задача себе' : 'Новое поручение'} onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
        </button>
      ) : null}

      <BottomNav tabs={tabs} active={active} onSelect={(id) => { setActive(id); if (id !== 'more') setSub(null); }} />

      {creating ? <CreateSheet mode={active === 'tasks' ? 'mine' : 'assigned'} me={user} onClose={() => setCreating(false)} /> : null}
      {profileOpen ? <ProfileSheet user={user} onClose={() => setProfileOpen(false)} /> : null}
      {linked ? <TaskDetailModal task={linked} responsible={undefined} onClose={() => setLinked(null)} /> : null}
    </div>
  );
}
