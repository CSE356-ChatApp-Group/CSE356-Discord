import { useState, useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { formatDistanceToNow } from 'date-fns';
import styles from './SearchBar.module.css';

export default function SearchBar({ onClose, placeholder = 'Search messages' }) {
  const { search, searchResults, searchQuery, clearSearch } = useChatStore();
  const [q, setQ] = useState(searchQuery);
  const inputRef  = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleChange(e) {
    setQ(e.target.value);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const query = q.trim();
    if (!query) {
      clearSearch();
      return;
    }
    await search(query);
  }

  function handleClose() {
    clearSearch();
    onClose();
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function displayAuthor(hit) {
    return (
      hit.authorDisplayName ||
      hit.author_display_name ||
      hit.author?.displayName ||
      hit.author?.display_name ||
      hit.author?.username ||
      hit.username ||
      'User'
    );
  }

  function highlightedContent(hit, query) {
    if (hit._formatted?.content) return hit._formatted.content;
    const safe = escapeHtml(hit.content || '');
    const trimmed = (query || '').trim();
    if (!trimmed) return safe;
    const re = new RegExp(`(${escapeRegex(trimmed)})`, 'ig');
    return safe.replace(re, '<mark>$1</mark>');
  }

  return (
    <div className={styles.panel} data-testid="search-bar">
      <div className={styles.top}>
        <form className={styles.inputRow} data-testid="search-input-row" onSubmit={handleSubmit}>
          <button className={styles.searchSubmit} type="submit" aria-label="Search" data-testid="search-submit">
            <svg className={styles.icon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
          <input
            ref={inputRef}
            value={q}
            onChange={handleChange}
            placeholder={placeholder}
            className={styles.input}
            name="search"
            data-testid="search-input"
          />
          {q && (
            <button type="button" className={styles.clear} onClick={() => { setQ(''); clearSearch(); }} aria-label="Clear search" data-testid="search-clear">
              ✕
            </button>
          )}
          <button type="button" className={styles.closeBtn} onClick={handleClose} data-testid="search-close">Done</button>
        </form>
        <div className={styles.summary} data-testid="search-summary">
          {searchResults === null
            ? ''
            : `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {searchResults !== null && (
        <div className={styles.results} data-testid="search-results">
          {searchResults.length === 0 ? (
            <p className={styles.none}>No results for "{q}"</p>
          ) : (
            searchResults.map(hit => (
              <div key={hit.id} className={styles.hit} data-testid={`search-hit-${hit.id}`}>
                <div className={styles.hitMeta}>
                  <span className={styles.hitAuthor}>{displayAuthor(hit)}</span>
                  <span className={styles.hitTime}>
                    {formatDistanceToNow(new Date(hit.createdAt), { addSuffix: true })}
                  </span>
                </div>
                <p
                  className={styles.hitContent}
                  dangerouslySetInnerHTML={{
                    __html: highlightedContent(hit, q),
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
