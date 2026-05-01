/**
 * Coalesces redundant GET /channels refetches for the same community (WS bursts).
 * fetchChannels() already calls invalidateApiCache for the list path — no duplicate invalidate here.
 */

const DEBOUNCE_MS = 400;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function cancelDebouncedCommunityChannelsRefetch(communityId: string): void {
  const t = timers.get(communityId);
  if (t) {
    clearTimeout(t);
    timers.delete(communityId);
  }
}

/** One network refresh after `DEBOUNCE_MS`, resetting the timer on each call (same community). */
export function scheduleDebouncedCommunityChannelsRefetch(
  communityId: string,
  fetchChannels: (communityId: string) => Promise<unknown>,
): void {
  const prev = timers.get(communityId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(communityId);
    void fetchChannels(communityId).catch(() => {});
  }, DEBOUNCE_MS);
  timers.set(communityId, t);
}

/** Cancels any pending debounced refetch, then runs fetch immediately (permission / access changes). */
export function runImmediateCommunityChannelsRefetch(
  communityId: string,
  fetchChannels: (communityId: string) => Promise<unknown>,
): void {
  cancelDebouncedCommunityChannelsRefetch(communityId);
  void fetchChannels(communityId).catch(() => {});
}
