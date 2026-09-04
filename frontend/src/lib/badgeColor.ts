// Deterministic per-user badge color so the same person reads as the same
// color everywhere (card, detail modal) without storing a color per user.
const BADGE_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-800',
  'bg-purple-100 text-purple-700',
  'bg-pink-100 text-pink-700',
  'bg-cyan-100 text-cyan-700',
  'bg-rose-100 text-rose-700',
  'bg-lime-100 text-lime-800',
];

export function userBadgeColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return BADGE_COLORS[Math.abs(hash) % BADGE_COLORS.length];
}
