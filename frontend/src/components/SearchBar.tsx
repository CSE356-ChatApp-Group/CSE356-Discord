import { useChatStore } from '../stores/chatStore';
import { formatDistanceToNow } from 'date-fns';
import styles from './SearchBar.module.css';

export default function SearchBar({ onClose }: { onClose: () => void }) {
  const { searchResults, searchQuery } = useChatStore();

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

  const count = searchResults?.length ?? 0;

  return (
    <div className={styles.panel} data-testid="search-bar">
      <div className={styles.resultsHeader} data-testid="search-results-header">
        <span className={styles.resultCount} data-testid="search-summary">
          {count} Result{count !== 1 ? 's' : ''}
        </span>
        <div className={styles.resultsActions}>
          <button className={styles.resultsActionBtn} disabled title="Filters (coming soon)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
            Filters
          </button>
          <button className={styles.resultsActionBtn} disabled title="Sort (coming soon)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 5h10M11 9h7M11 13h4"/><path d="M3 15l3 3 3-3M6 8v10"/></svg>
            Sort
          </button>
        </div>
      </div>

      <div className={styles.results} data-testid="search-results">
        {count === 0 ? (
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
