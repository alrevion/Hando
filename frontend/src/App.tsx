import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { BoardView } from './components/BoardView';
import { ArchiveTab } from './components/ArchiveTab';
import { PersonalArchiveTab } from './components/PersonalArchiveTab';
import { ArchivedProjectsView } from './components/ArchivedProjectsView';
import { AccessTab } from './components/AccessTab';
import { ApiError, getProjects, getTask } from './lib/api';
import type { Project, Task } from './types';

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectTab, setProjectTab] = useState<'board' | 'archive' | 'access'>('board');
  const [showPersonalArchive, setShowPersonalArchive] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [deepLinkTask, setDeepLinkTask] = useState<Task | null>(null);

  function loadProjects(selectId?: string) {
    getProjects()
      .then((data) => {
        setProjects(data);
        setLoadError(null);
        setSelectedProjectId((current) => selectId ?? current ?? data[0]?.id ?? null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load projects.'));
  }

  useEffect(() => loadProjects(), []);

  // Telegram notifications link to /?task=<id> so tapping one opens straight
  // to that task instead of just the board. Resolve it once on mount; an
  // invalid/inaccessible id just falls through to the normal app.
  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get('task');
    if (!taskId) return;
    window.history.replaceState(null, '', window.location.pathname);
    getTask(taskId)
      .then((task) => {
        setDeepLinkTask(task);
        setSelectedProjectId(task.project_id);
        setProjectTab('board');
        setShowPersonalArchive(false);
      })
      .catch(() => {});
  }, []);

  if (!user) return null; // AppShell guarantees user is set here

  const canManage = user.role === 'creator' || user.role === 'super_admin';
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  return (
    <div className="flex h-screen">
      <Sidebar
        user={user}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={(id) => {
          setSelectedProjectId(id);
          setProjectTab('board');
          setShowPersonalArchive(false);
          setShowArchivedProjects(false);
        }}
        personalArchiveActive={showPersonalArchive}
        onSelectPersonalArchive={() => {
          setShowPersonalArchive(true);
          setShowArchivedProjects(false);
        }}
        archivedProjectsActive={showArchivedProjects}
        onSelectArchivedProjects={() => {
          setShowArchivedProjects(true);
          setShowPersonalArchive(false);
        }}
        onProjectCreated={(project) => {
          loadProjects(project.id);
          setShowPersonalArchive(false);
          setShowArchivedProjects(false);
        }}
        onProjectDeleted={(projectId) => {
          setProjects((prev) => prev.filter((p) => p.id !== projectId));
          setSelectedProjectId((current) => (current === projectId ? null : current));
        }}
        onLogout={logout}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {loadError ? (
          <div role="alert" className="m-4 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
            {loadError}
          </div>
        ) : null}

        {showPersonalArchive ? (
          <PersonalArchiveTab />
        ) : showArchivedProjects ? (
          <ArchivedProjectsView onRestored={() => loadProjects()} />
        ) : selectedProject ? (
          <>
            {canManage ? (
              <div className="flex gap-1 border-b border-slate-200 bg-white px-6 pt-3">
                <button
                  type="button"
                  onClick={() => setProjectTab('board')}
                  aria-current={projectTab === 'board' ? 'page' : undefined}
                  className={`rounded-t-md px-3 py-1.5 text-sm font-medium ${
                    projectTab === 'board'
                      ? 'border border-b-0 border-slate-200 bg-slate-50 text-blue-700'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Board
                </button>
                <button
                  type="button"
                  onClick={() => setProjectTab('archive')}
                  aria-current={projectTab === 'archive' ? 'page' : undefined}
                  className={`rounded-t-md px-3 py-1.5 text-sm font-medium ${
                    projectTab === 'archive'
                      ? 'border border-b-0 border-slate-200 bg-slate-50 text-blue-700'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Archive
                </button>
                <button
                  type="button"
                  onClick={() => setProjectTab('access')}
                  aria-current={projectTab === 'access' ? 'page' : undefined}
                  className={`rounded-t-md px-3 py-1.5 text-sm font-medium ${
                    projectTab === 'access'
                      ? 'border border-b-0 border-slate-200 bg-slate-50 text-blue-700'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Access
                </button>
              </div>
            ) : null}

            <div className="min-h-0 flex-1">
              {projectTab === 'archive' && canManage ? (
                <ArchiveTab key={selectedProject.id} project={selectedProject} />
              ) : projectTab === 'access' && canManage ? (
                <AccessTab key={selectedProject.id} project={selectedProject} currentUser={user} />
              ) : (
                <BoardView
                  key={selectedProject.id}
                  project={selectedProject}
                  user={user}
                  initialTask={deepLinkTask?.project_id === selectedProject.id ? deepLinkTask : null}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
            Select a project to get started.
          </div>
        )}
      </main>
    </div>
  );
}

function AppShell() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  }
  if (!user) return <LoginPage />;
  return <AuthenticatedApp />;
}

function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

export default App;
