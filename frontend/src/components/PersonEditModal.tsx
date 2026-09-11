import { useState, type FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Role, User } from '../types';
import { ApiError, updateUser } from '../lib/api';

interface PersonEditModalProps {
  person: User;
  canPromoteToSuperAdmin: boolean; // only creator
  isSelf: boolean; // nobody edits their own role, super_admin included
  onClose: () => void;
  onSaved: () => void;
}

// One place to fix a name typo, a phone number, a Telegram handle, or a role --
// previously scattered across an inline role <select> and a separate inline
// username editor, with no way to touch name/phone at all.
export function PersonEditModal({ person, canPromoteToSuperAdmin, isSelf, onClose, onSaved }: PersonEditModalProps) {
  const [name, setName] = useState(person.name);
  const [phone, setPhone] = useState(person.phone);
  const [telegramUsername, setTelegramUsername] = useState(person.telegram_username ?? '');
  const [role, setRole] = useState<Role>(person.role);
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  void canPromoteToSuperAdmin; // ролей три: super_admin больше не выдаётся
  const isCreator = person.role === 'creator';
  const roleLocked = isCreator || isSelf;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    if (!name.trim()) nextErrors.name = 'Name is required.';
    if (!phone.trim()) nextErrors.phone = 'Phone number is required.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setFormError(null);
    setSubmitting(true);
    try {
      await updateUser(person.id, {
        name: name.trim(),
        phone: phone.trim(),
        telegram_username: telegramUsername.trim(),
        ...(roleLocked ? {} : { role: role as 'admin' | 'member' }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save these changes.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-edit-title"
        className="w-full max-w-sm rounded-lg bg-[var(--bg2)] p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="person-edit-title" className="text-lg font-semibold text-[var(--label)]">
            Edit person
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--label3)] hover:bg-[var(--fill2)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {formError ? (
          <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
            {formError}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor="person-name" className="mb-1 block text-sm font-medium text-[var(--label2)]">
            Name
          </label>
          <input
            id="person-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!errors.name}
            className="mb-1 w-full rounded-md border border-[var(--hair)] px-3 py-2 text-sm focus-visible:outline-blue-600"
          />
          {errors.name ? <p role="alert" className="mb-2 text-xs text-red-700">{errors.name}</p> : <div className="mb-2" />}

          <label htmlFor="person-phone" className="mb-1 block text-sm font-medium text-[var(--label2)]">
            Phone number
          </label>
          <input
            id="person-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={!!errors.phone}
            className="mb-1 w-full rounded-md border border-[var(--hair)] px-3 py-2 text-sm focus-visible:outline-blue-600"
          />
          {errors.phone ? <p role="alert" className="mb-2 text-xs text-red-700">{errors.phone}</p> : <div className="mb-2" />}

          <label htmlFor="person-username" className="mb-1 block text-sm font-medium text-[var(--label2)]">
            Telegram username (optional)
          </label>
          <div className="mb-4 flex items-center rounded-md border border-[var(--hair)] bg-[var(--bg2)] px-3 py-2 focus-within:outline focus-within:outline-2 focus-within:outline-blue-600">
            <span className="text-sm text-[var(--label3)]">@</span>
            <input
              id="person-username"
              value={telegramUsername}
              onChange={(e) => setTelegramUsername(e.target.value)}
              placeholder="telegram_username"
              className="w-full text-sm focus:outline-none"
            />
          </div>

          {roleLocked ? (
            <p className="mb-4 text-xs text-[var(--label3)]">
              {isCreator ? "Role: creator (can't be changed here)" : "Role: can't change your own role"}
            </p>
          ) : (
            <>
              <label htmlFor="person-role" className="mb-1 block text-sm font-medium text-[var(--label2)]">
                Role
              </label>
              <select
                id="person-role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="mb-4 w-full rounded-md border border-[var(--hair)] bg-[var(--bg2)] px-3 py-2 text-sm focus-visible:outline-blue-600"
              >
                <option value="admin">Руководитель отдела</option>
                <option value="member">Участник</option>
              </select>
            </>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--hair)] px-3 py-1.5 text-sm text-[var(--label2)] hover:bg-[var(--fill2)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
