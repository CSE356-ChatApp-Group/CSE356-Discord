import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { formatDistanceToNow } from 'date-fns';
import styles from './SearchBar.module.css';

export default function SearchBar({ onClose }: { onClose: () => void }) {
  const {
    searchResults,
    searchQuery,
    searchFilters,
    setSearchFilters,
    resetSearchFilters,
    search,
  } = useChatStore();
  const [showFilters, setShowFilters] = useState(true);

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

  function isRangeValid(filters) {
    return !(filters.after && filters.before && filters.after > filters.before);
  }

  function applyFilters(partial) {
    const nextFilters = { ...searchFilters, ...partial };
    setSearchFilters(nextFilters);
    if (isRangeValid(nextFilters)) {
      void search(searchQuery, nextFilters);
    }
  }

  function clearFilters() {
    resetSearchFilters();
    void search(searchQuery, { author: '', after: '', before: '' });
  }

  const count = searchResults?.length ?? 0;
  const hasSubmittedSearch = searchResults !== null;
  const activeFilterCount = [searchFilters.author, searchFilters.after, searchFilters.before]
    .filter(Boolean)
    .length;
  const invalidRange = !isRangeValid(searchFilters);

  return (
    <div className={styles.panel} data-testid="search-bar">
      <div className={styles.resultsHeader} data-testid="search-results-header">
        <span className={styles.resultCount} data-testid="search-summary">
          {hasSubmittedSearch ? `${count} Result${count !== 1 ? 's' : ''}` : 'Filters'}
        </span>
        <div className={styles.resultsActions}>
          <button
            type="button"
            className={`${styles.resultsActionBtn} ${showFilters || activeFilterCount ? styles.resultsActionBtnActive : ''}`}
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters}
            data-testid="search-filters-toggle"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </button>
          <button type="button" className={styles.resultsActionBtn} onClick={onClose} aria-label="Close search">
            Done
          </button>
        </div>
      </div>

      {showFilters && (
        <div className={styles.filtersPanel} data-testid="search-filters-panel">
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>Author</span>
            <input
              className={styles.filterInput}
              type="text"
              value={searchFilters.author}
              placeholder="username"
              autoComplete="off"
              onChange={(event) => applyFilters({ author: event.target.value })}
              data-testid="search-filter-author"
            />
          </label>

          <label className={styles.filterField}>
            <span className={styles.filterLabel}>Before</span>
            <input
              className={styles.filterInput}
              type="datetime-local"
              value={searchFilters.before}
              min={searchFilters.after || undefined}
              onChange={(event) => applyFilters({ before: event.target.value })}
              data-testid="search-filter-before"
            />
          </label>

          <label className={styles.filterField}>
            <span className={styles.filterLabel}>After</span>
            <input
              className={styles.filterInput}
              type="datetime-local"
              value={searchFilters.after}
              max={searchFilters.before || undefined}
              onChange={(event) => applyFilters({ after: event.target.value })}
              data-testid="search-filter-after"
            />
          </label>

          <div className={styles.filterActions}>
            <button
              type="button"
              className={styles.filterResetBtn}
              onClick={clearFilters}
              disabled={activeFilterCount === 0}
              data-testid="search-filters-reset"
            >
              Clear filters
            </button>
          </div>

          {invalidRange && (
            <p className={styles.filterError} data-testid="search-filter-error">
              The start time must be earlier than the end time.
            </p>
          )}
        </div>
      )}

      <div className={styles.results} data-testid="search-results">
        {!hasSubmittedSearch ? null : count === 0 ? (
          <p className={styles.none}>No results found.</p>
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
                  __html: highlightedContent(hit, searchQuery),
                }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
