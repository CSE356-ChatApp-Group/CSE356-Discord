export const DEFAULT_MEMBER_LIST_WIDTH = 236;
export const MIN_MEMBER_LIST_WIDTH = 140;
export const MAX_MEMBER_LIST_WIDTH = 420;
export const MEMBER_LIST_WIDTH_STORAGE_KEY = 'chatapp.memberListWidth';

export function getMaxMemberListWidth() {
  if (typeof window === 'undefined') return MAX_MEMBER_LIST_WIDTH;
  return Math.max(MIN_MEMBER_LIST_WIDTH, Math.min(MAX_MEMBER_LIST_WIDTH, Math.floor(window.innerWidth * 0.45)));
}

export function clampMemberListWidth(width: number) {
  return Math.min(getMaxMemberListWidth(), Math.max(MIN_MEMBER_LIST_WIDTH, width));
}

export function getInitialMemberListWidth() {
  if (typeof window === 'undefined') return DEFAULT_MEMBER_LIST_WIDTH;
  const stored = Number.parseInt(window.localStorage.getItem(MEMBER_LIST_WIDTH_STORAGE_KEY) || '', 10);
  if (Number.isFinite(stored)) return clampMemberListWidth(stored);
  return clampMemberListWidth(DEFAULT_MEMBER_LIST_WIDTH);
}
