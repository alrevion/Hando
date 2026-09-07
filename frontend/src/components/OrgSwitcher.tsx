import { Building2 } from 'lucide-react';
import type { User } from '../types';

/**
 * Заготовка переключателя организации.
 *
 * Показывает ТЕКУЩУЮ организацию -- единственное, что вообще известно клиенту:
 * GET /api/me отдаёт org_id/org_name того членства, в котором человек сейчас, а
 * списка его членств и роута смены организации в API пока нет. Поэтому здесь
 * подпись, а не выпадающий список: список из одной строки соврал бы, что других
 * организаций нет, а кнопка «сменить» вела бы в никуда.
 *
 * Когда появятся GET списка членств и роут смены, меняется только этот файл --
 * место в раскладке уже занято.
 */
export function OrgSwitcher({ user }: { user: User }) {
  if (!user.org_name) return null;

  return (
    <div className="border-b border-[var(--hair)] px-4 py-3">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 shrink-0 text-[var(--label3)]" aria-hidden="true" />
        <p className="truncate text-sm font-medium text-[var(--label)]" title={user.org_name}>
          {user.org_name}
        </p>
      </div>
      <p className="mt-0.5 text-xs text-[var(--label3)]">Переключение пока недоступно</p>
    </div>
  );
}
