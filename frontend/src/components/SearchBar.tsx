import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../stores/chatStore';
import { formatDistanceToNow } from 'date-fns';
import styles from './SearchBar.module.css';

export default function SearchBar({
  currentQuery,
  onResultSelect,
}: {
  currentQuery: string;
  onResultSelect?: () => void;
}) {
  const {
    searchResults,
    searchFilters,
    setSearchFilters,
    resetSearchFilters,
    clearSearch,
    search,
    jumpToSearchResult,
  } = useChatStore(
    useShallow((s) => ({
      searchResults: s.searchResults,
      searchFilters: s.searchFilters,
      setSearchFilters: s.setSearchFilters,
      resetSearchFilters: s.resetSearchFilters,
      clearSearch: s.clearSearch,
      search: s.search,
      jumpToSearchResult: s.jumpToSearchResult,
    })),
  );
  const [showFilters, setShowFilters] = useState(false);
  const [jumpingMessageId, setJumpingMessageId] = useState<string | null>(null);

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
    if (searchResults !== null) {
      clearSearch();
    }
  }

  function clearFilters() {
    resetSearchFilters();
    if (searchResults !== null) {
      clearSearch();
    }
  }

  const count = searchResults?.length ?? 0;
  const hasSubmittedSearch = searchResults !== null;
  const activeFilterCount = [searchFilters.author, searchFilters.after, searchFilters.before]
    .filter(Boolean)
    .length;
  const invalidRange = !isRangeValid(searchFilters);
  const canSubmit = Boolean(currentQuery.trim() || activeFilterCount);

  function submitSearch() {
    if (!canSubmit || invalidRange) return;
    void search(currentQuery, searchFilters);
  }

  async function handleHitClick(hit) {
    if (!hit?.id || jumpingMessageId) return;
    setJumpingMessageId(hit.id);
    try {
      await jumpToSearchResult(hit);
      onResultSelect?.();
    } catch (err) {
      console.error('Failed to jump to search result', err);
    } finally {
      setJumpingMessageId((current) => (current === hit.id ? null : current));
    }
  }

  return (
    <div className={styles.panel} data-testid="search-bar">
      <div className={styles.toolbar} data-testid="search-results-header">
        <button
          type="button"
          className={`${styles.resultsActionBtn} ${styles.resultsActionBtnPrimary} ${styles.searchSubmitBtn}`}
          onClick={submitSearch}
          disabled={!canSubmit || invalidRange}
          data-testid="search-submit"
        >
          Search
        </button>
        <button
          type="button"
          className={`${styles.filtersDisclosure} ${showFilters ? styles.filtersDisclosureOpen : ''}`}
          onClick={() => setShowFilters((value) => !value)}
          aria-expanded={showFilters}
          data-testid="search-filters-toggle"
        >
          <span className={styles.filtersDisclosureLabel}>
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </span>
          <span className={styles.filtersDisclosureChevron}>{showFilters ? '▾' : '▸'}</span>
        </button>
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
        {!hasSubmittedSearch ? null : (
          <div className={styles.resultsSummary} data-testid="search-summary">
            {count} Result{count !== 1 ? 's' : ''}
          </div>
        )}
        {!hasSubmittedSearch ? null : count === 0 ? (
          <p className={styles.none}>No results found.</p>
        ) : (
          searchResults.map(hit => (
            <button
              key={hit.id}
              type="button"
              className={styles.hit}
              data-testid={`search-hit-${hit.id}`}
              onClick={() => void handleHitClick(hit)}
              disabled={Boolean(jumpingMessageId)}
            >
              <div className={styles.hitMeta}>
                <span className={styles.hitAuthor}>{displayAuthor(hit)}</span>
                <span className={styles.hitTime}>
                  {formatDistanceToNow(new Date(hit.createdAt), { addSuffix: true })}
                </span>
              </div>
              <p
                className={styles.hitContent}
                dangerouslySetInnerHTML={{
                  __html: highlightedContent(hit, currentQuery),
                }}
              />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
