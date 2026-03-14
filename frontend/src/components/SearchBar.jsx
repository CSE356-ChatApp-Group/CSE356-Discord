import { useState, useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { formatDistanceToNow } from 'date-fns';
import styles from './SearchBar.module.css';

export default function SearchBar({ onClose }) {
  const { search, searchResults, searchQuery, clearSearch } = useChatStore();
  const [q, setQ] = useState(searchQuery);
  const inputRef  = useRef(null);
  const timerRef  = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleChange(e) {
    const val = e.target.value;
    setQ(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(val), 350);
  }

  function handleClose() {
    clearSearch();
    onClose();
  }

  return (
    <div className={styles.bar}>
      <div className={styles.inputRow}>
        <svg className={styles.icon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          ref={inputRef}
          value={q}
          onChange={handleChange}
          placeholder="Search messages…"
          className={styles.input}
        />
        {q && (
          <button className={styles.clear} onClick={() => { setQ(''); clearSearch(); }}>
            ✕
          </button>
        )}
        <button className={styles.closeBtn} onClick={handleClose}>Done</button>
      </div>

      {searchResults !== null && (
        <div className={styles.results}>
          {searchResults.length === 0 ? (
            <p className={styles.none}>No results for "{q}"</p>
          ) : (
            searchResults.map(hit => (
              <div key={hit.id} className={styles.hit}>
                <div className={styles.hitMeta}>
                  <span className={styles.hitAuthor}>{hit.authorId}</span>
                  <span className={styles.hitTime}>
                    {formatDistanceToNow(new Date(hit.createdAt), { addSuffix: true })}
                  </span>
                </div>
                <p
                  className={styles.hitContent}
                  dangerouslySetInnerHTML={{
                    // Meilisearch returns _formatted with <em> highlight tags
                    __html: hit._formatted?.content || hit.content || '',
                  }}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
