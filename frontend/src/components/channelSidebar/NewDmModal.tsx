import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import Modal from '../Modal';
import { api } from '../../lib/api';
import styles from '../ChannelSidebar.module.css';

export default function NewDmModal({
  currentUserId,
  onClose,
  onOpen,
}: {
  currentUserId?: string;
  onClose: () => void;
  onOpen: (participantIds: string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.get(`/users?q=${encodeURIComponent(q.trim())}`);
        const users: any[] = data.users ?? data ?? [];
        setResults(users.filter((u: any) => u.id !== currentUserId));
      } catch {
        setResults([]);
      }
    }, 250);
  }, [currentUserId]);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    search(e.target.value);
  }

  function toggleSelect(user: any) {
    if (!user?.id) return;
    setSelectedUsers((prev) => {
      const exists = prev.some((entry) => entry.id === user.id);
      if (exists) return prev.filter((entry) => entry.id !== user.id);
      return [...prev, user];
    });
  }

  async function handleCreateConversation(e: FormEvent) {
    e.preventDefault();
    if (!selectedUsers.length) {
      setErr('Select at least one user.');
      return;
    }

    setBusy(true);
    setErr('');
    try {
      await onOpen(selectedUsers.map((user) => user.id));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to open DM');
      setBusy(false);
    }
  }

  return (
    <Modal title="New message" onClose={onClose}>
      <form className={styles.newDmModal} data-testid="dm-create-modal" onSubmit={handleCreateConversation}>
        <input
          ref={inputRef}
          className={styles.newDmSearch}
          type="text"
          placeholder="Find people by name or username…"
          value={query}
          onChange={handleChange}
          data-testid="dm-search-input"
        />
        {err && <p className={styles.err}>{err}</p>}
        {selectedUsers.length > 0 && (
          <div className={styles.selectedUsers} data-testid="dm-selected-users">
            {selectedUsers.map((user) => (
              <button
                key={user.id}
                type="button"
                className={styles.selectedUserChip}
                onClick={() => toggleSelect(user)}
                data-testid={`dm-selected-user-${user.id}`}
              >
                <span>{user.displayName || user.display_name || user.username}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}
        {results.length > 0 && (
          <ul className={styles.newDmResults} data-testid="dm-search-results">
            {results.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={styles.newDmResultBtn}
                  onClick={() => toggleSelect(u)}
                  disabled={busy}
                  data-testid={`dm-user-result-${u.id}`}
                  data-user-id={u.id}
                >
                  <span className={styles.newDmResultName}>{u.displayName || u.display_name || u.username}</span>
                  {(u.username) && <span className={styles.newDmResultUsername}>@{u.username}</span>}
                  {selectedUsers.some((entry) => entry.id === u.id) && <span className={styles.newDmSelectedMark}>Selected</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() && results.length === 0 && (
          <p className={styles.hint}>No users found</p>
        )}
        <div className={styles.newDmActions}>
          <button type="button" className={styles.newDmCancelBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={styles.newDmCreateBtn} disabled={busy || selectedUsers.length === 0} data-testid="dm-create-submit">
            {busy ? 'Starting…' : selectedUsers.length > 1 ? 'Create group DM' : 'Start DM'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
