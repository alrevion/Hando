import { useEffect, useState } from 'react';
import { Copy, Link2, Plus, Send, Trash2 } from 'lucide-react';
import type { User } from '../types';
import {
  ApiError, createProject, deleteOrg, getInviteLink, getMe, getMyOrgs, getPacks, renameOrg, updateOrgSettings, type MyOrg, type OrgPack, type OrgSettingsPatch,
} from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { toast } from '../lib/toast';
import { Confirm } from './Confirm';

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/**
 * Организация (раздел 22): имя, удаление с вводом имени, профиль отрасли,
 * график работы, сводка, ссылка-приглашение. Владелец правит всё, руководитель
 * отдела видит и получает свою ссылку.
 */
export function OrgView({ user }: { user: User }) {
  const { setUser } = useAuth();
  const { refresh, projects } = useData();
  const [org, setOrg] = useState<MyOrg | null>(null);
  const [dept, setDept] = useState('');
  const [packs, setPacks] = useState<OrgPack[]>([]);
  const [invite, setInvite] = useState<{ link: string; code: string } | null>(null);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => { getMyOrgs().then((list) => { const cur = list.find((o) => o.is_current === 1) ?? null; setOrg(cur); setName(cur?.name ?? ''); }).catch(() => {}); };
  useEffect(load, []);
  useEffect(() => { getPacks().then((c) => setPacks(c.industries)).catch(() => {}); }, []);
  const owner = !!org && (org.owner_user_id === user.id || org.role === 'creator');
  const canInvite = !!org && (owner || org.role === 'admin' || org.role === 'super_admin');
  useEffect(() => { if (org && canInvite) getInviteLink(org.id).then(setInvite).catch(() => setInvite(null)); }, [org, canInvite]);

  async function save(patch: OrgSettingsPatch, done = 'Сохранено') {
    if (!org) return;
    setBusy(true);
    try { await updateOrgSettings(org.id, patch); toast(done); load(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); } finally { setBusy(false); }
  }
  if (!org) return <div className="lg:p-6"><h1 className="h1">Пространство</h1><p className="muted">Загрузка…</p></div>;
  const days = new Set(org.work_days.split(',').map(Number));
  const pack = packs.find((p) => p.id === org.industry_pack);
  // Отделы владелец видел «сверху вниз наоборот»: список приходит с сервера
  // как есть, а там порядок не гарантирован как «по возрастанию даты». Сортируем
  // сами -- так новый отдел всегда оказывается в конце, под формой добавления.
  const depts = [...projects].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  // И url, и text в t.me/share/url телеграм добавляет в готовое сообщение сам,
  // порядок частей мы не контролируем -- иногда ссылка оказывается впереди.
  // Поэтому кладём всё одной строкой в text: порядок «текст, потом ссылка»
  // получаем гарантированно, а голый URL в тексте Telegram всё равно подсветит
  // как кликабельную ссылку.
  const shareUrl = invite ? `https://t.me/share/url?text=${encodeURIComponent(`Присоединяйтесь к «${org.name}» в Hando AI: ${invite.link}`)}` : '';

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Пространство</h1>

      {/* Карточки идут в .stack -- без него они склеивались без отступа друг
          на друга, и экран выглядел «криво». */}
      <div className="stack">
      <div className="card">
        <div className="sec-title" style={{ marginTop: 0 }}>Пространство</div>
        {owner ? (
          <form className="field" style={{ marginBottom: 0 }} onSubmit={async (e) => { e.preventDefault(); if (!name.trim() || name.trim() === org.name) return; setBusy(true); try { await renameOrg(org.id, name.trim()); toast('Переименовано'); setUser((await getMe()).user); load(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); } finally { setBusy(false); } }}>
            <label className="lbl" htmlFor="org-title">Название</label>
            <div className="t-row" style={{ gap: 8 }}>
              <input id="org-title" className="inp" style={{ flex: '1 1 auto', minWidth: 0 }} value={name} onChange={(e) => setName(e.target.value)} />
              {/* width: auto ломает flex-basis, унаследованный от .btn (width:
                  100%) -- без него кнопка растягивалась на всю строку, а поле
                  рядом схлопывалось в узкий квадратик. */}
              <button type="submit" className="btn" style={{ flex: '0 0 auto', width: 'auto' }} disabled={busy || !name.trim() || name.trim() === org.name}>Сохранить</button>
            </div>
          </form>
        ) : <span className="t-title">{org.name}</span>}
        <span className="t-meta" style={{ marginTop: 6 }}><span>Профиль: {pack ? `${pack.emoji} ${pack.title}` : org.industry_pack ?? '—'}</span></span>
      </div>

      {canInvite ? (
        <div className="card">
          <div className="sec-title" style={{ marginTop: 0 }}>Пригласить сотрудника</div>
          <p className="hint" style={{ marginTop: 0 }}>Кто перейдёт по вашей ссылке, подаст заявку вам — вы подтверждаете и выбираете роль и отдел.</p>
          {invite ? (
            <>
              {/* overflow-wrap: anywhere ломает длинную ссылку по словам, где
                  можно, и только потом посреди слова -- в отличие от
                  break-all она не режет как попало короткие строки. */}
              <p className="muted" style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{invite.link}</p>
              <div className="btn-row">
                <button type="button" className="btn" onClick={() => { void navigator.clipboard?.writeText(invite.link); toast('Ссылка скопирована'); }}>
                  <Copy aria-hidden="true" style={{ width: 16, height: 16 }} />Копировать
                </button>
                <a className="btn btn-primary" href={shareUrl} target="_blank" rel="noreferrer">
                  <Send aria-hidden="true" style={{ width: 16, height: 16 }} />Отправить в Telegram
                </a>
              </div>
            </>
          ) : <p className="muted">Загрузка…</p>}
          {owner && org.join_code ? <p className="hint"><Link2 aria-hidden="true" style={{ width: 13, height: 13, verticalAlign: '-2px' }} /> Общий код пространства: <b>{org.join_code}</b> — заявки по нему приходят вам.</p> : null}
        </div>
      ) : null}

      {canInvite ? (
        <div className="card">
          <div className="sec-title" style={{ marginTop: 0 }}>Отделы</div>
          <div className="pills" style={{ marginBottom: 8 }}>
            {depts.map((p) => <span key={p.id} className="pill"><span>{p.name}</span></span>)}
          </div>
          <form className="t-row" style={{ gap: 8 }} onSubmit={async (e) => { e.preventDefault(); if (!dept.trim()) return; setBusy(true); try { await createProject(dept.trim()); toast('Отдел добавлен'); setDept(''); await refresh(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); } finally { setBusy(false); } }}>
            <input className="inp" style={{ flex: '1 1 auto', minWidth: 0 }} value={dept} placeholder="Новый отдел" onChange={(e) => setDept(e.target.value)} />
            <button type="submit" className="btn" style={{ flex: '0 0 auto', width: 'auto' }} disabled={busy || !dept.trim()}><Plus aria-hidden="true" style={{ width: 16, height: 16 }} />Добавить</button>
          </form>
          <p className="hint">Отдел — это доска: кого туда приняли, тот видит её задачи.</p>
        </div>
      ) : null}

      {owner ? (
        <>
          <div className="card">
            <div className="sec-title" style={{ marginTop: 0 }}>График работы</div>

            {/* 24/7 -- своя строка-переключатель. Текст обрезался потому, что
                ни .t-meta, ни .grow вне родителя .t-row не сжимаются сами по
                себе -- задаём flex и min-width явно, а перенос строк берём от
                .hint (он не запрещает white-space, в отличие от .t-meta). */}
            <label className="card card-tap" style={{ display: 'flex', gap: 10, alignItems: 'center', boxShadow: 'none', background: 'var(--fill2)', marginBottom: 12 }}>
              <input type="checkbox" checked={org.always_on === 1} disabled={busy} onChange={(e) => save({ always_on: e.target.checked ? 1 : 0 })} style={{ flex: '0 0 auto' }} />
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <span className="t-title" style={{ whiteSpace: 'normal' }}>24/7</span>
                <span className="hint" style={{ margin: '2px 0 0' }}>Без графика — «до завтра» значит до 23:59.</span>
              </span>
            </label>

            {/* Дни и часы 24/7-организации не нужны -- прячем блок целиком,
                а не показываем его серым и нерабочим. */}
            {org.always_on ? null : (
              <>
                <span className="lbl">Дни недели</span>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {DAYS.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      className={days.has(i + 1) ? 'chip on' : 'chip'}
                      disabled={busy}
                      // flex: 1 делит строку на 7 равных кнопок, min-height 44 --
                      // минимальная зона нажатия по гайдлайну (было 34px).
                      style={{ flex: '1 1 0', minWidth: 0, minHeight: 44, justifyContent: 'center', padding: 0 }}
                      onClick={() => {
                        const next = new Set(days); if (next.has(i + 1)) next.delete(i + 1); else next.add(i + 1);
                        if (next.size === 0) return;
                        void save({ work_days: [...next].sort().join(',') });
                      }}
                    >{d}</button>
                  ))}
                </div>

                <span className="lbl">Рабочий день</span>
                <div className="t-row" style={{ gap: 8, marginBottom: 12 }}>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">С</span>
                    <input key={org.work_start} type="time" className="inp" defaultValue={org.work_start} disabled={busy} onBlur={(e) => { if (e.target.value && e.target.value !== org.work_start) void save({ work_start: e.target.value }); }} /></label>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">До</span>
                    <input key={org.work_end} type="time" className="inp" defaultValue={org.work_end} disabled={busy} onBlur={(e) => { if (e.target.value && e.target.value !== org.work_end) void save({ work_end: e.target.value }); }} /></label>
                </div>

                <span className="lbl">Обед</span>
                <div className="t-row" style={{ gap: 8 }}>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">С</span>
                    <input key={org.lunch_start ?? ''} type="time" className="inp" defaultValue={org.lunch_start ?? ''} disabled={busy} onBlur={(e) => { if (e.target.value !== (org.lunch_start ?? '')) void save({ lunch_start: e.target.value || null }); }} /></label>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">До</span>
                    <input key={org.lunch_end ?? ''} type="time" className="inp" defaultValue={org.lunch_end ?? ''} disabled={busy} onBlur={(e) => { if (e.target.value !== (org.lunch_end ?? '')) void save({ lunch_end: e.target.value || null }); }} /></label>
                </div>

                <p className="hint">«До завтра» — до {org.work_end}. Вне графика — только срок и просрочка.</p>
              </>
            )}
          </div>

          <div className="card">
            <div className="sec-title" style={{ marginTop: 0 }}>Сводка на день</div>
            <label className="card card-tap" style={{ display: 'flex', gap: 10, alignItems: 'center', boxShadow: 'none', background: 'var(--fill2)' }}>
              <input type="checkbox" checked={org.digest_enabled === 1} disabled={busy} onChange={(e) => save({ digest_enabled: e.target.checked ? 1 : 0 })} />
              <span className="grow"><span className="t-title">Присылать сводку</span><span className="t-meta"><span>Задачи со сроком сегодня и черновики — каждому в пространстве.</span></span></span>
            </label>
            {org.digest_enabled ? (
              <label className="field" style={{ marginTop: 10, marginBottom: 0 }}><span className="lbl">Час сводки (пусто — начало рабочего дня)</span>
                <input key={org.digest_time ?? ''} type="time" className="inp" defaultValue={org.digest_time ?? ''} disabled={busy} onBlur={(e) => { if (e.target.value !== (org.digest_time ?? '')) void save({ digest_time: e.target.value || null }); }} /></label>
            ) : null}
          </div>

          <div className="card">
            <div className="sec-title" style={{ marginTop: 0 }}>Подписка</div>
            <p className="hint" style={{ marginTop: 0 }}>За «{org.name}» платит владелец. Сейчас всё бесплатно — оплата ещё не подключена; когда появится, тариф будет здесь.</p>
          </div>

          <div className="card">
            <div className="sec-title" style={{ marginTop: 0 }}>Удаление</div>
            <p className="hint" style={{ marginTop: 0 }}>Задачи и история сохранятся, но пространство исчезнет у всех его участников. Для подтверждения нужно ввести её название.</p>
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden="true" style={{ width: 16, height: 16 }} />Удалить пространство
            </button>
          </div>
        </>
      ) : null}
      </div>

      {confirmDelete ? (
        <Confirm
          title={`Удалить «${org.name}»?`}
          text="Задачи и история сохранятся, но пространство исчезнет у всех его участников."
          confirmLabel="Удалить"
          confirmWord={org.name}
          onConfirm={async () => {
            await deleteOrg(org.id);
            setUser((await getMe()).user);
            await refresh();
            toast('Пространство удалено');
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  );
}
