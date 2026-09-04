import { useState, type FormEvent } from 'react';
import { LogOut, Plus, FolderKanban, ClipboardCheck, Archive, ArchiveRestore, Loader2, CalendarDays, ListChecks, Users } from 'lucide-react';
import type { Project, User } from '../types';
import { ApiError, createProject, deleteProject } from '../lib/api';
import { OrgSwitcher } from './OrgSwitcher';

// Что показано справа. Одно значение вместо набора взаимоисключающих флагов:
// экранов стало шесть, и каждый новый флаг требовал бы гасить все остальные
// в каждом обработчике -- ровно там и заводятся состояния «открыто два экрана».
export type NavView = 'board' | 'my-tasks' | 'people' | 'calendar' | 'personal-archive' | 'archived-projects';

interface SidebarProps {
  user: User;
  projects: Project[];
  selectedProjectId: string | null;
  view: NavView;
  onSelectView: (view: NavView) => void;
  onSelectProject: (id: string) => void;
  onProjectCreated: (project: { id: string; name: string }) => void;
  onProjectDeleted: (projectId: string) => void;
  onLogout: () => void;
}

// Сквозные экраны -- они же порядок в меню: сотрудник заходит ради «Мои задачи»,
// поэтому она первая, а не после списка досок.
const CROSS_VIEWS: { view: NavView; label: string; icon: typeof ListChecks; managersOnly: boolean }[] = [
  { view: 'my-tasks', label: 'Мои задачи', icon: ListChecks, managersOnly: false },
  // «Люди» держится на GET /api/users, который роли member отвечает 403 --
  // пункт меню, ведущий в гарантированную ошибку, ей не показываем.
  { view: 'people', label: 'Люди', icon: Users, managersOnly: true },
  { view: 'calendar', label: 'Календарь', icon: CalendarDays, managersOnly: false },
];

export function Sidebar({
  user,
  projects,
  selectedProjectId,
  view,
  onSelectView,
  onSelectProject,
  onProjectCreated,
  onProjectDeleted,
  onLogout,
}: SidebarProps) {
  const canManageProjects = user.role === 'creator' || user.role === 'super_admin';
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  // "Delete" here is a soft archive (backend never hard-deletes a project) --
  // restorable later from Archived projects, hence the wording/icon below.
  async function handleArchive(project: Project) {
    if (!window.confirm(`Archive "${project.name}"? You can restore it later from Archived projects.`)) return;
    setArchivingId(project.id);
    try {
      await deleteProject(project.id);
      onProjectDeleted(project.id);
    } catch {
      setError('Could not archive that project.');
    } finally {
      setArchivingId(null);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Project name is required.');
      return;
    }
    if (!groupId.replace(/\D/g, '')) {
      setError('Telegram group ID is required.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const project = await createProject(name.trim(), groupId.trim());
      onProjectCreated(project);
      setName('');
      setGroupId('');
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <nav
      aria-label="Projects"
      className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white"
    >
      <OrgSwitcher user={user} />

      <div className="border-b border-slate-200 p-4">
        <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
        <p className="text-xs text-slate-500">{user.position || user.role.replace('_', ' ')}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <ul className="mb-4 space-y-0.5">
          {CROSS_VIEWS.filter((item) => !item.managersOnly || user.role !== 'member').map((item) => (
            <li key={item.view}>
              <button
                type="button"
                onClick={() => onSelectView(item.view)}
                aria-current={view === item.view ? 'page' : undefined}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                  view === item.view ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Projects
          </span>
          {canManageProjects ? (
            <button
              type="button"
              aria-label="Add project"
              onClick={() => setShowAddForm((v) => !v)}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {showAddForm ? (
          <form onSubmit={handleCreate} className="mb-3 px-1" noValidate>
            <label htmlFor="new-project-name" className="sr-only">
              New project name
            </label>
            <input
              id="new-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="mb-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus-visible:outline-blue-600"
            />
            <label htmlFor="new-project-group" className="sr-only">
              Telegram group ID
            </label>
            <input
              id="new-project-group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              placeholder="Telegram group ID (e.g. 1234567890)"
              className="mb-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus-visible:outline-blue-600"
            />
            <p className="mb-1 text-xs text-slate-500">
              Just the group ID -- the -100 supergroup prefix is added automatically.
            </p>
            {error ? (
              <p role="alert" className="mb-1 text-xs text-red-700">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </form>
        ) : null}

        <ul className="space-y-0.5">
          {projects.map((project) => (
            <li key={project.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelectProject(project.id)}
                aria-current={view === 'board' && selectedProjectId === project.id ? 'page' : undefined}
                className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                  view === 'board' && selectedProjectId === project.id
                    ? 'bg-blue-50 font-medium text-blue-700'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <FolderKanban className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{project.name}</span>
              </button>
              {canManageProjects ? (
                <button
                  type="button"
                  onClick={() => handleArchive(project)}
                  disabled={archivingId === project.id}
                  aria-label={`Archive ${project.name}`}
                  title="Archive this project"
                  className="shrink-0 rounded p-1 text-slate-300 opacity-0 hover:bg-slate-100 hover:text-slate-600 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                >
                  {archivingId === project.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              ) : null}
            </li>
          ))}
          {projects.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-slate-500">No projects yet.</li>
          ) : null}
        </ul>

        {/* GET /api/archive/mine ролью не ограничен, и member -- такой же
            исполнитель, как admin: свой закрытый список нужен обоим. */}
        {user.role === 'admin' || user.role === 'member' ? (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={() => onSelectView('personal-archive')}
              aria-current={view === 'personal-archive' ? 'page' : undefined}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                view === 'personal-archive'
                  ? 'bg-blue-50 font-medium text-blue-700'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <ClipboardCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
              My completed tasks
            </button>
          </div>
        ) : null}

        {canManageProjects ? (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={() => onSelectView('archived-projects')}
              aria-current={view === 'archived-projects' ? 'page' : undefined}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                view === 'archived-projects'
                  ? 'bg-blue-50 font-medium text-blue-700'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <ArchiveRestore className="h-4 w-4 shrink-0" aria-hidden="true" />
              Archived projects
            </button>
          </div>
        ) : null}
      </div>

      <div className="border-t border-slate-200 p-3">
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Log out
        </button>
      </div>
    </nav>
  );
}
