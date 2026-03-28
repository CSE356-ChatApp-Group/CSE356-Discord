import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { useAutoResize } from '../hooks/useAutoResize';
import MessageItem  from './MessageItem';
import SearchBar    from './SearchBar';
import MemberList   from './MemberList';
import styles from './MessagePane.module.css';

export default function MessagePane() {
  const { activeChannel, activeConv, messages, sendMessage, fetchMessages, search, searchResults, clearSearch } = useChatStore();
  const user = useAuthStore(s => s.user);

  const target   = activeChannel || activeConv;
  const key      = target?.id;
  const msgList  = (messages[key] || []);

  const [content, setContent]     = useState('');
  const [sending, setSending]     = useState(false);
  const [loadingMore, setLoadMore] = useState(false);
  const [showSearch, setSearch]   = useState(false);
  const [showMembers, setShowMembers] = useState(Boolean(activeChannel));
  const [localQ, setLocalQ]       = useState('');
  const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';
  const searchInputRef = useRef<HTMLInputElement>(null);

  const bottomRef   = useRef(null);
  const inputRef    = useRef(null);
  const scrollRef   = useRef(null);
  useAutoResize(inputRef);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgList.length, key]);

  // Focus input when channel changes
  useEffect(() => {
    inputRef.current?.focus();
    setSearch(false);
    setShowMembers(Boolean(activeChannel));
    clearSearch();
    setLocalQ('');
  }, [key]);

  // Focus search input and clean up when search panel toggles
  useEffect(() => {
    if (showSearch) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else {
      clearSearch();
      setLocalQ('');
    }
  }, [showSearch]);

  useEffect(() => {
    function onShortcut(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
        setShowMembers(false);
      }
      if (e.key === 'Escape') {
        setSearch(false);
        setShowMembers(false);
      }
    }

    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  async function handleSearchSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const query = localQ.trim();
    if (!query) return;
    await search(query);
  }

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    setLocalQ(e.target.value);
    if (searchResults !== null) clearSearch();
  }

  function closeSearch() {
    setSearch(false);
    clearSearch();
    setLocalQ('');
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!content.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(content.trim());
      setContent('');
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  }

  // Infinite scroll – load older messages when scrolled to top
  const handleScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || loadingMore || msgList.length === 0) return;
    if (el.scrollTop < 80) {
      setLoadMore(true);
      const prevH = el.scrollHeight;
      await fetchMessages({
        channelId:      activeChannel?.id,
        conversationId: activeConv?.id,
        before:         msgList[0]?.id,
      });
      // Restore scroll position after prepend
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevH;
      });
      setLoadMore(false);
    }
  }, [loadingMore, msgList, activeChannel, activeConv]);

  const title = activeChannel
    ? `# ${activeChannel.name}`
    : activeConv?.name || 'Direct Message';

  const otherLastReadMessageId = activeConv?.other_last_read_message_id || activeConv?.otherLastReadMessageId;
  const otherLastReadAt = activeConv?.other_last_read_at || activeConv?.otherLastReadAt;
  let latestOwnMessageId: string | null = null;
  for (let i = msgList.length - 1; i >= 0; i -= 1) {
    const m = msgList[i];
    if (!m?.deleted_at && m?.author_id === user?.id) {
      latestOwnMessageId = m.id;
      break;
    }
  }
  let latestOwnSeen = false;
  if (latestOwnMessageId) {
    const ownIdx = msgList.findIndex(m => m.id === latestOwnMessageId);
    if (ownIdx >= 0 && otherLastReadMessageId) {
      const seenIdx = msgList.findIndex(m => m.id === otherLastReadMessageId);
      if (seenIdx >= ownIdx) latestOwnSeen = true;
    }
    if (!latestOwnSeen && otherLastReadAt && ownIdx >= 0) {
      latestOwnSeen = new Date(otherLastReadAt).getTime() >= new Date(msgList[ownIdx].created_at).getTime();
    }
  }

  const searchScope = activeChannel
    ? `#${activeChannel.name}`
    : activeConv?.name
      ? `@${activeConv.name}`
      : 'messages';
  const searchLabel = `Search ${searchScope}`;

  const placeholder = activeChannel
    ? `Message #${activeChannel.name}`
    : 'Message';

  return (
    <div className={styles.pane} data-testid="message-pane">
      {/* Header */}
      <header className={styles.header} data-testid="message-pane-header">
        <div className={styles.headerLeft}>
          <span className={styles.headerTitle} data-testid="message-pane-title">{title}</span>
          {activeChannel?.description && (
            <span className={styles.headerDesc}>{activeChannel.description}</span>
          )}
        </div>
        <div className={styles.headerActions}>
          {activeChannel && (
            <button
              className={`${styles.iconTrigger} ${showMembers ? styles.iconTriggerActive : ''}`}
              title="Toggle member list"
              onClick={() => {
                setShowMembers(v => {
                  const next = !v;
                  if (next) setSearch(false);
                  return next;
                });
              }}
              aria-label="Toggle member list"
              data-testid="message-members-toggle"
            >
              <MembersIcon />
            </button>
          )}
          {showSearch ? (
            <div className={styles.searchBox} data-testid="search-box">
              <form className={styles.searchForm} onSubmit={handleSearchSubmit}>
                <span className={styles.searchFormIcon}><SearchIcon /></span>
                <input
                  ref={searchInputRef}
                  className={styles.searchFormInput}
                  value={localQ}
                  onChange={handleSearchChange}
                  placeholder={searchLabel}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="search-input"
                />
                <button
                  type="button"
                  className={styles.searchClear}
                  onClick={closeSearch}
                  aria-label="Close search"
                >✕</button>
              </form>
              {searchResults === null && (
                <div className={styles.searchPopout} data-testid="search-popout">
                  {localQ.trim() ? (
                    <button
                      className={styles.searchPopoutOption}
                      type="button"
                      onClick={handleSearchSubmit}
                    >
                      <SearchIcon />
                      <span>Search for <strong>{localQ.trim()}</strong></span>
                    </button>
                  ) : (
                    <div className={styles.searchPopoutHint}>
                      <SearchIcon />
                      <span>Start typing to search {activeChannel ? `#${activeChannel.name}` : 'messages'}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <button
              className={styles.searchTrigger}
              title={searchLabel}
              onClick={() => { setSearch(true); setShowMembers(false); }}
              aria-label="Toggle message search"
              data-testid="message-search-toggle"
            >
              <SearchIcon />
              <span className={styles.searchTriggerText}>{searchLabel}</span>
              <span className={styles.searchTriggerHint}>{shortcutLabel}</span>
            </button>
          )}
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.mainColumn}>
          {/* Messages */}
          <div className={styles.messages} ref={scrollRef} onScroll={handleScroll} role="log" aria-live="polite" aria-label="Message history" data-testid="message-list">
            {loadingMore && <div className={styles.loadingMore}>Loading…</div>}
            {msgList.length === 0 && (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}>{activeChannel ? '#' : '@'}</span>
                <p>Start of <strong>{title}</strong></p>
                <p className={styles.emptyHint}>Be the first to say something.</p>
              </div>
            )}
            {msgList.map((msg, i) => (
              <MessageItem
                key={msg.id}
                message={msg}
                prevMessage={msgList[i - 1]}
                isOwn={msg.author_id === user?.id}
                showReadReceipt={Boolean(activeConv && msg.id === latestOwnMessageId && latestOwnSeen)}
              />
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form className={styles.inputRow} onSubmit={handleSend} data-testid="message-compose-form">
            <textarea
              ref={inputRef}
              className={styles.input}
              id="message-compose-input"
              name="content"
              value={content}
              onChange={e => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              maxLength={4000}
              disabled={sending}
              data-testid="message-compose-input"
            />
            <button
              type="submit"
              className={styles.sendBtn}
              disabled={!content.trim() || sending}
              title="Send (Enter)"
              aria-label="Send message"
              data-testid="message-send"
            >
              <SendIcon />
            </button>
          </form>
        </div>

        {/* Right sidebar (members/search) */}
        {showMembers && activeChannel && (
          <aside className={styles.searchSidebar} data-testid="message-members-sidebar">
            <MemberList />
          </aside>
        )}
        {showSearch && searchResults !== null && (
          <aside className={styles.searchSidebar} data-testid="message-search-sidebar">
            <SearchBar onClose={closeSearch} />
          </aside>
        )}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function MembersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}
