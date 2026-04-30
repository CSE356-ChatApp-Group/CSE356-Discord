import type { Entity } from './chatStoreTypes';

export function normalizeSearchDateTime(value?: string | null) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

export function resolveSearchAuthorId(authorText: string, members: Entity[], activeConv: Entity | null) {
  const normalized = String(authorText || '').trim().toLowerCase();
  if (!normalized) return '';

  const candidates = activeConv
    ? (Array.isArray(activeConv.participants) ? activeConv.participants : [])
    : (Array.isArray(members) ? members : []);

  const exactUsername = candidates.find((entry) => {
    const username = String(entry?.username || '').trim().toLowerCase();
    return username === normalized;
  });

  return exactUsername?.id || '';
}
