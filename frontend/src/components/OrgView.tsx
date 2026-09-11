import { useEffect, useState } from 'react';
import { Copy, Link2, Send, Trash2 } from 'lucide-react';
import type { User } from '../types';
import {
  ApiError, deleteOrg, getInviteLink, getMe, getMyOrgs, getPacks, renameOrg, updateOrgSettings, type MyOrg, type OrgPack, type OrgSettingsPatch,
} from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { toast } from '../lib/toast';
import { AskText } from './AskText';

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/**
 * Организация (раздел 22): имя, удаление с вводом имени, профиль отрасли,
 * график работы, сводка, ссылка-приглашение. Владелец правит всё, руководитель
 * отдела видит и получает свою ссылку.
 */
export function OrgView({ user }: { user: User }) {
  const { setUser } = useAuth();
  const { refresh } = useData();
  const [org, setOrg] = useState<MyOrg | null>(null);
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
  if (!org) return <div className="lg:p-6"><h1 className="h1">Организация</h1><p className="muted">Загрузка…</p></div>;
  const days = new Set(org.work_days.split(',').map(Number));
  const pack = packs.find((p) => p.id === org.industry_pack);
  const shareUrl = invite ? `https://t.me/share/url?url=${encodeURIComponent(invite.link)}&text=${encodeURIComponent(`Присоединяйтесь к «${org.name}» в Hando`)}` : '';

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Организация</h1>

      <div className="card">
        {owner ? (
          <form className="field" style={{ marginBottom: 0 }} onSubmit={async (e) => { e.preventDefault(); if (!name.trim() || name.trim() === org.name) return; setBusy(true); try { await renameOrg(org.id, name.trim()); toast('Переименовано'); setUser((await getMe()).user); load(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); } finally { setBusy(false); } }}>
            <label className="lbl" htmlFor="org-title">Название</label>
            <div className="t-row" style={{ gap: 8 }}>
              <input id="org-title" className="inp" style={{ flex: '1 1 auto', minWidth: 0 }} value={name} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className="btn" style={{ flex: '0 0 auto' }} disabled={busy || !name.trim() || name.trim() === org.name}>Сохранить</button>
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
              <p className="muted" style={{ wordBreak: 'break-all', fontSize: 13 }}>{invite.link}</p>
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
          {owner && org.join_code ? <p className="hint"><Link2 aria-hidden="true" style={{ width: 13, height: 13, verticalAlign: '-2px' }} /> Общий код организации: <b>{org.join_code}</b> — заявки по нему приходят вам.</p> : null}
        </div>
      ) : null}

      {owner ? (
        <>
          <div className="card">
            <div className="sec-title" style={{ marginTop: 0 }}>График работы</div>
            <label className="card card-tap" style={{ display: 'flex', gap: 10, alignItems: 'center', boxShadow: 'none', background: 'var(--fill2)', marginBottom: 10 }}>
              <input type="checkbox" checked={org.always_on === 1} disabled={busy} onChange={(e) => save({ always_on: e.target.checked ? 1 : 0 })} />
              <span className="grow"><span className="t-title">24/7</span><span className="t-meta"><span>Семья и личные дела: графика нет, «до завтра» — до 23:59.</span></span></span>
            </label>
            {org.always_on ? null : (
              <>
                <div className="chips" style={{ paddingBottom: 8, flexWrap: 'wrap', overflowX: 'visible' }}>
                  {DAYS.map((d, i) => (
                    <button key={d} type="button" className={days.has(i + 1) ? 'chip on' : 'chip'} disabled={busy} onClick={() => {
                      const next = new Set(days); if (next.has(i + 1)) next.delete(i + 1); else next.add(i + 1);
                      if (next.size === 0) return;
                      void save({ work_days: [...next].sort().join(',') });
                    }}>{d}</button>
                  ))}
                </div>
                <div className="t-row" style={{ gap: 8 }}>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">Начало</span>
                    <input key={org.work_start} type="time" className="inp" defaultValue={org.work_start} disabled={busy} onBlur={(e) => { if (e.target.value && e.target.value !== org.work_start) void save({ work_start: e.target.value }); }} /></label>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">Конец</span>
                    <input key={org.work_end} type="time" className="inp" defaultValue={org.work_end} disabled={busy} onBlur={(e) => { if (e.target.value && e.target.value !== org.work_end) void save({ work_end: e.target.value }); }} /></label>
                </div>
                <div className="t-row" style={{ gap: 8, marginTop: 8 }}>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">Обед с</span>
                    <input key={org.lunch_start ?? ''} type="time" className="inp" defaultValue={org.lunch_start ?? ''} disabled={busy} onBlur={(e) => { if (e.target.value !== (org.lunch_start ?? '')) void save({ lunch_start: e.target.value || null }); }} /></label>
                  <label className="field grow" style={{ marginBottom: 0 }}><span className="lbl">до</span>
                    <input key={org.lunch_end ?? ''} type="time" className="inp" defaultValue={org.lunch_end ?? ''} disabled={busy} onBlur={(e) => { if (e.target.value !== (org.lunch_end ?? '')) void save({ lunch_end: e.target.value || null }); }} /></label>
                </div>
                <p className="hint">«До завтра» — до {org.work_end}. Рабочие напоминания приходят только в это время; срок и просрочка — всегда.</p>
              </>
            )}
          </div>

          <div className="card">
            <div className="sec-title" style={{ marginTop: 0 }}>Сводка на день</div>
            <label className="card card-tap" style={{ display: 'flex', gap: 10, alignItems: 'center', boxShadow: 'none', background: 'var(--fill2)' }}>
              <input type="checkbox" checked={org.digest_enabled === 1} disabled={busy} onChange={(e) => save({ digest_enabled: e.target.checked ? 1 : 0 })} />
              <span className="grow"><span className="t-title">Присылать сводку</span><span className="t-meta"><span>Задачи со сроком сегодня и черновики — каждому в организации.</span></span></span>
            </label>
            {org.digest_enabled ? (
              <label className="field" style={{ marginTop: 10, marginBottom: 0 }}><span className="lbl">Час сводки (пусто — начало рабочего дня)</span>
                <input key={org.digest_time ?? ''} type="time" className="inp" defaultValue={org.digest_time ?? ''} disabled={busy} onBlur={(e) => { if (e.target.value !== (org.digest_time ?? '')) void save({ digest_time: e.target.value || null }); }} /></label>
            ) : null}
          </div>

          <div className="card">
            <div className="sec-title" style={{ marginTop: 0 }}>Удаление</div>
            <p className="hint" style={{ marginTop: 0 }}>Задачи и история сохранятся, но организация исчезнет у всех её сотрудников. Для подтверждения нужно ввести её название.</p>
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden="true" style={{ width: 16, height: 16 }} />Удалить организацию
            </button>
          </div>
        </>
      ) : null}

      {confirmDelete ? (
        <AskText title={`Удалить «${org.name}»?`} placeholder="Введите название организации" submitLabel="Удалить" danger
          onSubmit={async (text) => {
            if (text.trim() !== org.name) throw new Error('Название не совпадает.');
            await deleteOrg(org.id);
            setUser((await getMe()).user);
            await refresh();
            toast('Организация удалена');
          }}
          onClose={() => setConfirmDelete(false)} />
      ) : null}
    </div>
  );
}
