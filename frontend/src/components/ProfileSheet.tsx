import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { LogOut, Pencil, Plus, Trash2 } from 'lucide-react';
import type { User } from '../types';
import {
  ApiError, cachedMyOrgs, deleteOrg, getMe, getMyOrgs, leaveOrg,
  renameOrg, setMyName, switchOrg, type MyOrg,
} from '../lib/api';
import { OrgJoinForm } from './OrgJoinForm';
import { Confirm } from './Confirm';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';

const ROLE_NAME: Record<string, string> = {
  creator: 'Владелец',
  super_admin: 'Руководитель',
  admin: 'Руководитель отдела',
  member: 'Участник',
};

const JOIN_ERROR: Record<string, string> = {
  unknown_code: 'Код не подошёл. Проверьте у того, кто его дал.',
  already_member: 'Вы уже в этой организации.',
  already_pending: 'Заявка уже подана, ждём подтверждения.',
};

/**
 * Профиль и организации -- то же, что в боте кнопками «Профиль» и
 * «Организации».
 *
 * Правило владельца: что можно в приложении, то можно и в боте, и наоборот.
 * Права здесь не проверяются -- их проверяет сервер теми же функциями, что
 * обслуживают экраны бота (см. routes.ts, раздел «организации»). Своя копия
 * правил разошлась бы с ботом на первой правке и разошлась бы молча.
 *
 * Единственное исключение -- САМАЯ ПЕРВАЯ организация: сессия приложения
 * выдаётся только тому, у кого организация уже есть, поэтому первый вход
 * всегда через бота.
 */
export function ProfileSheet({ user, onClose }: { user: User; onClose: () => void }) {
  const { setUser } = useAuth();
  const { refresh } = useData();
  // Прошлый ответ рисуется сразу, свежий приезжает следом: шторка открывается
  // со списком, а не с пустотой на его месте.
  const [orgs, setOrgs] = useState<MyOrg[]>(() => cachedMyOrgs() ?? []);
  const [firstLoad, setFirstLoad] = useState(cachedMyOrgs() === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Что сейчас редактируется: имя, название организации, новая организация, код.
  const [edit, setEdit] = useState<{ kind: 'name' | 'rename' | 'create'; orgId?: string } | null>(null);
  const [draft, setDraft] = useState('');
  // Имя нужно самому Confirm -- строгий режим сверяет набранное со словом.
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const load = () => {
    getMyOrgs().then(setOrgs).catch(() => setOrgs([])).finally(() => setFirstLoad(false));
  };
  useEffect(load, []);

  /** Общая обёртка: одна кнопка -- одно действие -- один разбор ошибки. */
  async function run(fn: () => Promise<unknown>, after?: 'reload' | 'orgs') {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
      setEdit(null);
      setDraft('');
      if (after === 'reload') {
        // Сменилась организация -- меняется всё: и кто я в ней, и её данные.
        setUser((await getMe()).user);
        await refresh();
      }
      load();
    } catch (err) {
      const code = err instanceof ApiError ? err.code ?? err.message : '';
      setError(JOIN_ERROR[code] ?? (err instanceof ApiError ? err.message : 'Не получилось. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, placeholder: string, onSubmit: () => void) => (
    <form
      className="field"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
    >
      <label className="lbl" htmlFor="profile-input">{label}</label>
      <input
        id="profile-input"
        className="inp"
        autoFocus
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => { setEdit(null); setDraft(''); }}>Отмена</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>Сохранить</button>
      </div>
    </form>
  );

  return (
    <Sheet title="Профиль" onClose={onClose}>
        {error ? <div role="alert" className="alert alert-err">{error}</div> : null}
        {info ? <div role="status" className="alert alert-ok">{info}</div> : null}

        {/* ---- имя ---- */}
        {edit?.kind === 'name' ? (
          field('Как к Вам обращаться', 'Имя и фамилия', () => run(() => setMyName(draft.trim()), 'reload'))
        ) : (
          <div className="card">
            <div className="t-row" style={{ alignItems: 'center' }}>
              <span className="grow">
                <span className="t-title">{user.name}</span>
                <span className="t-meta"><span>Это имя видят коллеги в поручениях</span></span>
              </span>
              <button
                type="button"
                className="btn-icon"
                aria-label="Изменить имя"
                onClick={() => { setEdit({ kind: 'name' }); setDraft(user.name); }}
              >
                <Pencil aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* ---- организации ---- */}
        <h3 className="sec-title">Организации</h3>
        {firstLoad && orgs.length === 0 ? <p className="muted">Загрузка…</p> : null}
        <ul className="stack">
          {orgs.map((org) => {
            const owner = org.owner_user_id === user.id || org.role === 'creator';
            const current = org.is_current === 1;
            return (
              <li key={org.id} className="card" style={current ? { boxShadow: 'inset 0 0 0 1.5px var(--accent)' } : undefined}>
                {edit?.kind === 'rename' && edit.orgId === org.id ? (
                  field('Новое название', org.name, () => run(() => renameOrg(org.id, draft.trim()), 'reload'))
                ) : (
                  <>
                    <div className="t-row" style={{ alignItems: 'center' }}>
                      <span className="grow">
                        <span className="t-title">{org.name}</span>
                        <span className="t-meta">
                          <span>{ROLE_NAME[org.role] ?? org.role}</span>
                          {current ? <><span>·</span><span className="c-green">текущая</span></> : null}
                        </span>
                      </span>
                      {!current ? (
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => switchOrg(org.id), 'reload')}>
                          Открыть
                        </button>
                      ) : null}
                    </div>

                    {owner && org.join_code ? (
                      <div className="pills">
                        {/* Код раздают сотрудникам: сам по себе доступа не даёт, только заявку. */}
                        <span className="pill"><span>Код для сотрудников: {org.join_code}</span></span>
                      </div>
                    ) : null}

                    <div className="btn-row">
                      {owner ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => { setEdit({ kind: 'rename', orgId: org.id }); setDraft(org.name); }}
                          >
                            <Pencil aria-hidden="true" style={{ width: 14, height: 14 }} />
                            Переименовать
                          </button>
                          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmDelete({ id: org.id, name: org.name })}>
                            <Trash2 aria-hidden="true" style={{ width: 14, height: 14 }} />
                            Удалить
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(() => leaveOrg(org.id), 'reload')}>
                          <LogOut aria-hidden="true" style={{ width: 14, height: 14 }} />
                          Выйти
                        </button>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>

        {confirmDelete ? (
          <Confirm
            title={`Удалить «${confirmDelete.name}»?`}
            text="Задачи и история сохранятся, но организация исчезнет у всех её сотрудников."
            confirmLabel="Удалить"
            confirmWord={confirmDelete.name}
            onConfirm={async () => {
              // Организаций может не остаться -- тогда обновлять склад нечем:
              // снимок без организации отвечает 401, и экран «создайте или
              // вступите» получил бы поверх себя ошибку.
              const { org_id } = await deleteOrg(confirmDelete.id);
              setUser((await getMe()).user);
              if (org_id) await refresh();
              load();
            }}
            onClose={() => setConfirmDelete(null)}
          />
        ) : null}

        {edit?.kind === 'create' ? (
          <OrgJoinForm
            onCancel={() => setEdit(null)}
            onDone={async (kind, name) => {
              if (kind === 'requested') { setInfo(`Заявка в «${name}» отправлена. Ждём подтверждения.`); setEdit(null); load(); return; }
              // Сменилась организация -- меняется всё: и кто я в ней, и её данные.
              setEdit(null);
              setUser((await getMe()).user);
              await refresh();
              load();
            }}
          />
        ) : (
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setEdit({ kind: 'create' })}>
              <Plus aria-hidden="true" style={{ width: 16, height: 16 }} />
              Создать или вступить
            </button>
          </div>
        )}
    </Sheet>
  );
}
