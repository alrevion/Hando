import { ChevronRight, Building2, FileText, HelpCircle, Layers, UserRound, Users, Bell } from 'lucide-react';
import type { User } from '../types';

export type MoreSub = 'people' | 'org' | 'drafts' | 'all' | 'notify' | 'ask';

/** «Ещё»: то, куда ходят раз в день, а не каждые пять минут. */
export function MoreView({ user, onOpen, onProfile }: { user: User; onOpen: (sub: MoreSub) => void; onProfile: () => void }) {
  const boss = user.role !== 'member';
  const rows: { key: MoreSub | 'profile'; title: string; hint: string; icon: typeof Users }[] = [
    { key: 'profile', title: 'Профиль', hint: `${user.name} · ${user.org_name ?? ''}`, icon: UserRound },
    { key: 'people', title: 'Люди', hint: boss ? 'Кто на каком этапе, роли, заявки' : 'Коллеги по вашим доскам', icon: Users },
    { key: 'org', title: 'Организация', hint: 'Название, график, сводка, ссылка-приглашение', icon: Building2 },
    { key: 'drafts', title: 'Черновики', hint: 'Продиктовано, но не подтверждено', icon: FileText },
    ...(boss ? [{ key: 'all' as const, title: 'Все задания', hint: 'Обзор вашего поддерева', icon: Layers }] : []),
    { key: 'notify', title: 'Уведомления', hint: 'Режим и «за сколько минут»', icon: Bell },
    { key: 'ask', title: 'Вопрос', hint: 'Как пользоваться и за что взяться', icon: HelpCircle },
  ];
  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Ещё</h1>
      <ul className="stack" style={{ gap: 6 }}>
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <li key={r.key}>
              <button type="button" className="card card-tap more-row" onClick={() => (r.key === 'profile' ? onProfile() : onOpen(r.key))}>
                <span className="more-ic"><Icon aria-hidden="true" /></span>
                <span className="grow"><span className="t-title">{r.title}</span><span className="t-meta"><span>{r.hint}</span></span></span>
                <ChevronRight aria-hidden="true" style={{ width: 18, height: 18, color: 'var(--label4)', flexShrink: 0 }} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
