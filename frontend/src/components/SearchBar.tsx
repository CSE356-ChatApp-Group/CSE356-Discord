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

      {searchResults === null ? (
        <div className={styles.filterMenu} data-testid="search-filter-menu">
          <div className={styles.filterGroup}>
            <div className={styles.filterLabel}>Filters</div>
          </div>
          <div className={styles.filterOptionsList}>
            <div className={styles.filterOption}>
              <svg className={styles.filterIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              <div className={styles.filterOptionText}>
                <div className={styles.filterOptionTitle}>From a specific user</div>
                <div className={styles.filterOptionCode}>from: user</div>
              </div>
            </div>
            <div className={styles.filterOption}>
              <svg className={styles.filterIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <div className={styles.filterOptionText}>
                <div className={styles.filterOptionTitle}>Sent in a specific channel</div>
                <div className={styles.filterOptionCode}>in: channel</div>
              </div>
            </div>
            <div className={styles.filterOption}>
              <svg className={styles.filterIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3m0 0a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3m0 0a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              <div className={styles.filterOptionText}>
                <div className={styles.filterOptionTitle}>Includes a specific type of data</div>
                <div className={styles.filterOptionCode}>has: link, embed or file</div>
              </div>
            </div>
            <div className={styles.filterOption}>
              <svg className={styles.filterIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                <text x="12" y="14" textAnchor="middle" fontSize="8" fill="currentColor">@</text>
              </svg>
              <div className={styles.filterOptionText}>
                <div className={styles.filterOptionTitle}>Mentions a specific user</div>
                <div className={styles.filterOptionCode}>mentions: user</div>
              </div>
            </div>
            <div className={styles.filterOption}>
              <svg className={styles.filterIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
              <div className={styles.filterOptionText}>
                <div className={styles.filterOptionTitle}>More filters</div>
                <div className={styles.filterOptionCode}>dates, author type, and more</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
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
