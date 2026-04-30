/**
 * Small helpers for the HTTP search route (env clamps, log metadata).
 */

function searchInstanceMeta() {
  return {
    vm: process.env.VM_NAME || process.env.HOSTNAME || 'unknown',
    worker: process.env.PORT || process.env.WORKER_PORT || 'unknown',
  };
}

function clampSearchPaging(limitRaw, offsetRaw) {
  const maxLimit = Math.min(Math.max(parseInt(process.env.SEARCH_MAX_LIMIT || '50', 10), 1), 100);
  const maxOffset = Math.min(Math.max(parseInt(process.env.SEARCH_MAX_OFFSET || '500', 10), 0), 2000);
  const lim = Math.min(Math.max(parseInt(String(limitRaw || '20'), 10) || 20, 1), maxLimit);
  const off = Math.min(Math.max(parseInt(String(offsetRaw || '0'), 10) || 0, 0), maxOffset);
  return { limit: lim, offset: off };
}

module.exports = {
  searchInstanceMeta,
  clampSearchPaging,
};
