import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../Modal';
import { api } from '../../lib/api';
import styles from '../CommunitySidebar.module.css';

export default function JoinCommunityModal({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (community: any) => Promise<void>;
}) {
  const [allCommunities, setAllCommunities] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const lastLoadedAtRef = useRef(0);

  const loadCommunities = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setErr('');
    try {
      const data = await api.get('/communities');
      const browseable = (data?.communities ?? []).filter((c: any) => !c.my_role);
      setAllCommunities(browseable);
      lastLoadedAtRef.current = Date.now();
    } catch (e: any) {
      setErr(e?.message || 'Could not load communities');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCommunities(true);
  }, [loadCommunities]);

  useEffect(() => {
    if (!query.trim()) return;
    const timer = window.setTimeout(() => {
      void loadCommunities(false);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadCommunities, query]);

  const filtered = query.trim()
    ? allCommunities.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.slug.toLowerCase().includes(query.toLowerCase())
      )
    : allCommunities;

  async function join(community: any) {
    const communityId = String(community?.id || '').trim();
    if (!communityId) {
      setErr('Missing community id; please refresh and try again.');
      return;
    }
    setErr('');
    setBusyId(communityId);
    try {
      await api.post(`/communities/${communityId}/join`, {});
      await onJoined(community);
    } catch (e: any) {
      setErr(e?.message || 'Could not join community');
      setBusyId(null);
    }
  }

  return (
    <Modal title="Browse Communities" onClose={onClose}>
      <div className={styles.joinWrap}>
        <input
          className={styles.joinSearch}
          placeholder="Search communities…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (Date.now() - lastLoadedAtRef.current > 30_000) {
              void loadCommunities(false);
            }
          }}
          autoFocus
          data-testid="community-join-search"
        />
        {err && <p className={styles.err} role="alert">{err}</p>}
        {loading ? (
          <p className={styles.accountMuted}>Loading…</p>
        ) : filtered.length === 0 ? (
          <p className={styles.joinEmpty}>
            {allCommunities.length === 0 ? 'No public communities available.' : 'No communities match your search.'}
          </p>
        ) : (
          <ul className={styles.joinList} data-testid="community-join-list">
            {filtered.map(c => (
              <li key={c.id} className={styles.joinItem} data-testid={`community-join-item-${c.id}`}>
                <div className={styles.joinItemInfo}>
                  <span className={styles.joinItemName}>{c.name}</span>
                  {c.description && <span className={styles.joinItemDesc}>{c.description}</span>}
                  <span className={styles.joinItemMeta}>{c.member_count ?? 0} members</span>
                </div>
                <button
                  className={styles.joinBtn}
                  disabled={busyId !== null}
                  onClick={() => join(c)}
                  data-testid={`community-join-btn-${c.id}`}
                >
                  {busyId === c.id ? 'Joining…' : 'Join'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
