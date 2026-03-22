import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { useAutoResize } from '../hooks/useAutoResize';
import MessageItem  from './MessageItem';
import SearchBar    from './SearchBar';
import styles from './MessagePane.module.css';

export default function MessagePane() {
  const { activeChannel, activeConv, messages, sendMessage, fetchMessages } = useChatStore();
  const user = useAuthStore(s => s.user);

  const target   = activeChannel || activeConv;
  const key      = target?.id;
  const msgList  = (messages[key] || []);

  const [content, setContent]     = useState('');
  const [sending, setSending]     = useState(false);
  const [loadingMore, setLoadMore] = useState(false);
  const [showSearch, setSearch]   = useState(false);

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
  }, [key]);

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

  const placeholder = activeChannel
    ? `Message #${activeChannel.name}`
    : 'Message';

  return (
    <div className={styles.pane}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.headerTitle}>{title}</span>
          {activeChannel?.description && (
            <span className={styles.headerDesc}>{activeChannel.description}</span>
          )}
        </div>
        <button
          className={`${styles.headerBtn} ${showSearch ? styles.headerBtnActive : ''}`}
          title="Search messages"
          onClick={() => setSearch(s => !s)}
        >
          <SearchIcon />
        </button>
      </header>

      {/* Search bar (collapsible) */}
      {showSearch && <SearchBar onClose={() => setSearch(false)} />}

      {/* Messages */}
      <div className={styles.messages} ref={scrollRef} onScroll={handleScroll}>
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
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form className={styles.inputRow} onSubmit={handleSend}>
        <textarea
          ref={inputRef}
          className={styles.input}
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          maxLength={4000}
          disabled={sending}
        />
        <button
          type="submit"
          className={styles.sendBtn}
          disabled={!content.trim() || sending}
          title="Send (Enter)"
        >
          <SendIcon />
        </button>
      </form>
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

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}
