import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Pencil, UserMinus, UserPlus } from 'lucide-react';
import type { Project, ProjectMember, Role, User } from '../types';
import { ApiError, addMember, createUser, getProjectMembers, getUsers, removeMember } from '../lib/api';
import { PersonEditModal } from './PersonEditModal';

interface AccessTabProps {
  project: Project;
  currentUser: User;
}

// Combines the two access-management jobs the interview asked for that had no
// screen yet: creating people (phone/name/role, invite-only -- no self-signup)
// and assigning/removing them from this project. Only super_admin/creator ever
// see this tab (gated by the caller), matching the backend's role checks.
export function AccessTab({ project, currentUser }: AccessTabProps) {
  const canCreateSuperAdmin = currentUser.role === 'creator'; // only creator may promote -- mirrors backend
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [editingPerson, setEditingPerson] = useState<User | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getUsers(), getProjectMembers(project.id)])
      .then(([users, mems]) => {
        setAllUsers(users);
        setMembers(mems);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load people.'))
      .finally(() => setLoading(false));
  }, [project.id]);

  useEffect(load, [load]);

  const memberIds = new Set(members.map((m) => m.id));
  // Each board has its own people now (see routes.ts requireProjectAccess) --
  // super_admins need an explicit row here too, same as admins, unless they
  // already show up implicitly (global creator, or this project's own creator).
  const nonMembers = allUsers.filter((u) => !memberIds.has(u.id) && (u.role === 'admin' || u.role === 'super_admin'));

  async function handleAdd(userId: string) {
    setBusyUserId(userId);
    try {
      await addMember(project.id, userId);
      load();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not add that person.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleRemove(userId: string) {
    setBusyUserId(userId);
    try {
      await removeMember(project.id, userId);
      load();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not remove that person.');
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold text-slate-900">{project.name} — Access</h1>

      {loadError ? (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}

      <CreatePersonForm currentUser={currentUser} projectId={project.id} onCreated={load} />

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Members of this project
        </h2>
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-slate-500">No admins assigned to this project yet.</p>
        ) : (
          <ul className="space-y-1">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{m.name}</span>
                  <span className="text-xs text-slate-400">· {m.role.replace('_', ' ')}</span>
                  <span className="text-xs text-slate-400">{m.telegram_username ? `@${m.telegram_username}` : 'no Telegram username'}</span>
                  <button
                    type="button"
                    onClick={() => setEditingPerson(m)}
                    aria-label={`Edit ${m.name}`}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-blue-700"
                  >
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
                {m.is_member ? (
                  <button
                    type="button"
                    onClick={() => handleRemove(m.id)}
                    disabled={busyUserId === m.id}
                    aria-label={`Remove ${m.name} from this project`}
                    className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {busyUserId === m.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <UserMinus className="h-3 w-3" aria-hidden="true" />
                    )}
                    Remove
                  </button>
                ) : (
                  // No membership row to remove: either the global creator, or this
                  // project's own creator (implicit access, not a formal member row).
                  <span className="shrink-0 text-xs text-slate-400">always has access</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add an existing person to this project
        </h2>
        {nonMembers.length === 0 ? (
          <p className="text-sm text-slate-500">
            Everyone eligible is already assigned, or no admin accounts exist yet -- create one above.
          </p>
        ) : (
          <ul className="space-y-1">
            {nonMembers.map((u) => (
              <li
                key={u.id}
                className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span>{u.name}</span>
                  <button
                    type="button"
                    onClick={() => setEditingPerson(u)}
                    aria-label={`Edit ${u.name}`}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-blue-700"
                  >
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => handleAdd(u.id)}
                  disabled={busyUserId === u.id}
                  className="flex shrink-0 items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {busyUserId === u.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <UserPlus className="h-3 w-3" aria-hidden="true" />
                  )}
                  Add
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editingPerson ? (
        <PersonEditModal
          person={editingPerson}
          canPromoteToSuperAdmin={canCreateSuperAdmin}
          isSelf={editingPerson.id === currentUser.id}
          onClose={() => setEditingPerson(null)}
          onSaved={load}
        />
      ) : null}
    </div>
  );
}

function CreatePersonForm({
  currentUser,
  projectId,
  onCreated,
}: {
  currentUser: User;
  projectId: string;
  onCreated: () => void;
}) {
  const canCreateSuperAdmin = currentUser.role === 'creator';
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [telegramUsername, setTelegramUsername] = useState('');
  const [role, setRole] = useState<Role>('admin');
  const [errors, setErrors] = useState<{ phone?: string; name?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    if (!phone.trim()) nextErrors.phone = 'Phone number is required.';
    if (!name.trim()) nextErrors.name = 'Name is required.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setFormError(null);
    setSubmitting(true);
    try {
      const created = await createUser({
        phone: phone.trim(),
        name: name.trim(),
        role: role as 'admin' | 'super_admin',
        telegram_username: telegramUsername.trim() || undefined,
      });
      // You're always creating someone from inside a specific project's Access tab --
      // add them here too in the same step, instead of a separate easy-to-miss step.
      await addMember(projectId, created.id).catch(() => {}); // best-effort
      setPhone('');
      setName('');
      setTelegramUsername('');
      setRole('admin');
      onCreated();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not create that person.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Create a new person
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        Invite-only: this is the only way a phone number becomes able to sign in.
      </p>

      {formError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {formError}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="new-person-phone" className="mb-1 block text-xs font-medium text-slate-700">
            Phone number
          </label>
          <input
            id="new-person-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={!!errors.phone}
            aria-describedby={errors.phone ? 'new-person-phone-error' : undefined}
            className="w-44 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline-blue-600"
          />
          {errors.phone ? (
            <p id="new-person-phone-error" role="alert" className="mt-1 text-xs text-red-700">
              {errors.phone}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="new-person-name" className="mb-1 block text-xs font-medium text-slate-700">
            Name
          </label>
          <input
            id="new-person-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? 'new-person-name-error' : undefined}
            className="w-44 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline-blue-600"
          />
          {errors.name ? (
            <p id="new-person-name-error" role="alert" className="mt-1 text-xs text-red-700">
              {errors.name}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="new-person-username" className="mb-1 block text-xs font-medium text-slate-700">
            Telegram username (optional)
          </label>
          <div className="flex w-44 items-center rounded-md border border-slate-300 bg-white px-2 py-1.5 focus-within:outline focus-within:outline-2 focus-within:outline-blue-600">
            <span className="text-sm text-slate-400">@</span>
            <input
              id="new-person-username"
              value={telegramUsername}
              onChange={(e) => setTelegramUsername(e.target.value)}
              placeholder="telegram_username"
              className="w-full text-sm focus:outline-none"
            />
          </div>
        </div>

        {canCreateSuperAdmin ? (
          <div>
            <label htmlFor="new-person-role" className="mb-1 block text-xs font-medium text-slate-700">
              Role
            </label>
            <select
              id="new-person-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-blue-600"
            >
              <option value="admin">Admin</option>
              <option value="super_admin">Super-admin</option>
            </select>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Create
        </button>
      </form>
    </section>
  );
}
