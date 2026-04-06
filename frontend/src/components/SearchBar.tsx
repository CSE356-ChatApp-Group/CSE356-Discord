import { useMemo, useState } from 'react';
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
    members,
    activeConv,
  } = useChatStore();
  const [showFilters, setShowFilters] = useState(searchResults === null);

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

  function displayUser(user) {
    return (
      user?.displayName ||
      user?.display_name ||
      user?.username ||
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

  const availableAuthors = useMemo(() => {
    const source = activeConv
      ? (Array.isArray(activeConv.participants) ? activeConv.participants : [])
      : (Array.isArray(members) ? members : []);
    const deduped = new Map();

    source.forEach((entry) => {
      if (!entry?.id || deduped.has(entry.id)) return;
      deduped.set(entry.id, entry);
    });

    return Array.from(deduped.values()).sort((a, b) =>
      displayUser(a).localeCompare(displayUser(b), undefined, { sensitivity: 'base' })
    );
  }, [activeConv, members]);

  function applyFilters(partial) {
    const nextFilters = { ...searchFilters, ...partial };
    setSearchFilters(nextFilters);
    if (searchQuery.trim().length >= 2 && isRangeValid(nextFilters)) {
      void search(searchQuery, nextFilters);
    }
  }

  function clearFilters() {
    resetSearchFilters();
    if (searchQuery.trim().length >= 2) {
      void search(searchQuery, { authorId: '', after: '', before: '' });
    }
  }

  const count = searchResults?.length ?? 0;
  const hasSubmittedSearch = searchResults !== null;
  const activeFilterCount = [searchFilters.authorId, searchFilters.after, searchFilters.before]
    .filter(Boolean)
    .length;
  const invalidRange = !isRangeValid(searchFilters);

  return (
    <div className={styles.panel} data-testid="search-bar">
      <div className={styles.resultsHeader} data-testid="search-results-header">
        <span className={styles.resultCount} data-testid="search-summary">
          {hasSubmittedSearch ? `${count} Result${count !== 1 ? 's' : ''}` : 'Search Filters'}
        </span>
        <div className={styles.resultsActions}>
          <button
            type="button"
            className={`${styles.resultsActionBtn} ${showFilters || activeFilterCount ? styles.resultsActionBtnActive : ''}`}
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters || !hasSubmittedSearch}
            data-testid="search-filters-toggle"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </button>
          <button className={styles.resultsActionBtn} disabled title="Sort (coming soon)" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 5h10M11 9h7M11 13h4"/><path d="M3 15l3 3 3-3M6 8v10"/></svg>
            Sort
          </button>
        </div>
      </div>

      {(showFilters || !hasSubmittedSearch) && (
        <div className={styles.filtersPanel} data-testid="search-filters-panel">
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>From</span>
            <select
              className={styles.filterInput}
              value={searchFilters.authorId}
              onChange={(event) => applyFilters({ authorId: event.target.value })}
              data-testid="search-filter-author"
            >
              <option value="">All people</option>
              {availableAuthors.map((author) => (
                <option key={author.id} value={author.id}>
                  {displayUser(author)}
                </option>
              ))}
            </select>
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
            <button
              type="button"
              className={styles.filterCloseBtn}
              onClick={() => setShowFilters(false)}
            >
              Done
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
        {!hasSubmittedSearch ? (
          <p className={styles.none}>
            {searchQuery.trim()
              ? 'Press Enter above to search with these filters.'
              : 'Type a query above, adjust filters here, then search.'}
          </p>
        ) : count === 0 ? (
          <p className={styles.none}>No results for &ldquo;{searchQuery}&rdquo;</p>
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
