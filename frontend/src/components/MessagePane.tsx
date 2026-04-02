import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { useAutoResize } from '../hooks/useAutoResize';
import { api } from '../lib/api';
import MessageItem  from './MessageItem';
import SearchBar    from './SearchBar';
import MemberList   from './MemberList';
import Modal        from './Modal';
import styles from './MessagePane.module.css';

const DEFAULT_MEMBER_LIST_WIDTH = 236;
const MIN_MEMBER_LIST_WIDTH = 140;
const MAX_MEMBER_LIST_WIDTH = 420;
const MEMBER_LIST_WIDTH_STORAGE_KEY = 'chatapp.memberListWidth';

function getMaxMemberListWidth() {
  if (typeof window === 'undefined') return MAX_MEMBER_LIST_WIDTH;
  return Math.max(MIN_MEMBER_LIST_WIDTH, Math.min(MAX_MEMBER_LIST_WIDTH, Math.floor(window.innerWidth * 0.45)));
}

function clampMemberListWidth(width: number) {
  return Math.min(getMaxMemberListWidth(), Math.max(MIN_MEMBER_LIST_WIDTH, width));
}

function getInitialMemberListWidth() {
  if (typeof window === 'undefined') return DEFAULT_MEMBER_LIST_WIDTH;
  const stored = Number.parseInt(window.localStorage.getItem(MEMBER_LIST_WIDTH_STORAGE_KEY) || '', 10);
  if (Number.isFinite(stored)) return clampMemberListWidth(stored);
  return clampMemberListWidth(DEFAULT_MEMBER_LIST_WIDTH);
}

export default function MessagePane() {
  const {
    activeCommunity,
    activeChannel,
    activeConv,
    messages,
    sendMessage,
    fetchMessages,
    search,
    searchResults,
    clearSearch,
    fetchChannelMembers,
    inviteToChannel,
    inviteToConversation,
    leaveConversation,
    renameGroupDm,
    members,
  } = useChatStore();
  const user = useAuthStore(s => s.user);

  const target   = activeChannel || activeConv;
  const key      = target?.id;
  const msgList  = (messages[key] || []);

  const [content, setContent]     = useState('');
  const [sending, setSending]     = useState(false);
  const [loadingMore, setLoadMore] = useState(false);
  const [showSearch, setSearch]   = useState(false);
  const [localQ, setLocalQ]       = useState('');
  const [showDmInviteModal, setShowDmInviteModal] = useState(false);
  const [showDmLeaveModal, setShowDmLeaveModal] = useState(false);
  const [showChannelInviteModal, setShowChannelInviteModal] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<any[]>([]);
  const [selectedInvitees, setSelectedInvitees] = useState<any[]>([]);
  const [channelInviteQuery, setChannelInviteQuery] = useState('');
  const [selectedChannelInvitees, setSelectedChannelInvitees] = useState<any[]>([]);
  const [privateChannelMembers, setPrivateChannelMembers] = useState<any[]>([]);
  const [dmInviteBusy, setDmInviteBusy] = useState(false);
  const [dmLeaveBusy, setDmLeaveBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [channelInviteBusy, setChannelInviteBusy] = useState(false);
  const [channelInviteLoading, setChannelInviteLoading] = useState(false);
  const [dmActionErr, setDmActionErr] = useState('');
  const [channelInviteErr, setChannelInviteErr] = useState('');
  const [memberListWidth, setMemberListWidth] = useState(getInitialMemberListWidth);
  const [isMemberListResizing, setIsMemberListResizing] = useState(false);
  const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const inviteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bottomRef   = useRef(null);
  const inputRef    = useRef(null);
  const scrollRef   = useRef(null);
  const bodyRef     = useRef<HTMLDivElement | null>(null);
  const initialScrollKeyRef = useRef<string | null>(null);
  const prevMsgCountRef = useRef(0);
  const exhaustedBeforeRef = useRef<string | null>(null);
  const historyRetryAfterRef = useRef(0);
  useAutoResize(inputRef);

  // Default each conversation to newest messages, and only auto-follow when already near bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!key) {
      initialScrollKeyRef.current = null;
      prevMsgCountRef.current = 0;
      exhaustedBeforeRef.current = null;
      historyRetryAfterRef.current = 0;
      return;
    }
    if (!el || msgList.length === 0) return;

    if (initialScrollKeyRef.current !== key) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      initialScrollKeyRef.current = key;
      prevMsgCountRef.current = msgList.length;
      return;
    }

    const countIncreased = msgList.length > prevMsgCountRef.current;
    if (countIncreased) {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distanceFromBottom < 120;
      if (nearBottom) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }

    prevMsgCountRef.current = msgList.length;
  }, [key, msgList.length]);

  // Reset name editing when conversation changes
  useEffect(() => {
    setEditingName(false);
    setDraftName('');
  }, [activeConv?.id]);

  // Focus input when channel changes
  useEffect(() => {
    inputRef.current?.focus();
    setSearch(false);
    clearSearch();
    setLocalQ('');
    setShowDmInviteModal(false);
    setShowDmLeaveModal(false);
    setShowChannelInviteModal(false);
    setDmActionErr('');
    setInviteQuery('');
    setInviteResults([]);
    setSelectedInvitees([]);
    setChannelInviteQuery('');
    setSelectedChannelInvitees([]);
    setPrivateChannelMembers([]);
    setChannelInviteErr('');
  }, [key]);

  useEffect(() => {
    if (showDmInviteModal) {
      requestAnimationFrame(() => inviteInputRef.current?.focus());
    }
  }, [showDmInviteModal]);

  useEffect(() => () => {
    if (inviteDebounceRef.current) clearTimeout(inviteDebounceRef.current);
  }, []);

  const existingDmMemberIds = useMemo(() => {
    return new Set((activeConv?.participants || []).map((participant) => participant.id));
  }, [activeConv]);

  const existingPrivateChannelMemberIds = useMemo(() => {
    return new Set((privateChannelMembers || []).map((member) => member.id));
  }, [privateChannelMembers]);

  const privateChannelInviteResults = useMemo(() => {
    if (!activeChannel?.is_private) return [];
    const query = channelInviteQuery.trim().toLowerCase();
    return (members || [])
      .filter((member) => !existingPrivateChannelMemberIds.has(member.id))
      .filter((member) => {
        if (!query) return true;
        const name = (member.displayName || member.display_name || member.username || '').toLowerCase();
        const username = (member.username || '').toLowerCase();
        return name.includes(query) || username.includes(query);
      })
      .slice(0, 20);
  }, [activeChannel, channelInviteQuery, existingPrivateChannelMemberIds, members]);

  const canManagePrivateChannel = Boolean(
    activeChannel?.is_private && ['owner', 'admin', 'moderator'].includes(activeCommunity?.my_role || activeCommunity?.myRole)
  );

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
      }
      if (e.key === 'Escape') {
        setSearch(false);
      }
    }

    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  // Persist member list width to localStorage
  useEffect(() => {
    window.localStorage.setItem(MEMBER_LIST_WIDTH_STORAGE_KEY, String(memberListWidth));
  }, [memberListWidth]);

  // Handle window resize to clamp member list width
  useEffect(() => {
    const handleResize = () => {
      setMemberListWidth((current) => clampMemberListWidth(current));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  function startMemberListResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    setIsMemberListResizing(true);

    const updateWidth = (clientX: number) => {
      const bodyRight = bodyRef.current?.getBoundingClientRect().right ?? 0;
      const nextWidth = clampMemberListWidth(bodyRight - clientX);
      setMemberListWidth(nextWidth);
    };

    updateWidth(event.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    const finishResize = () => {
      setIsMemberListResizing(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
  }

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
      setTimeout(() => inputRef.current?.focus(), 0);
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

  function handleInviteToDm() {
    if (!activeConv?.id) return;
    setDmActionErr('');
    setInviteQuery('');
    setInviteResults([]);
    setSelectedInvitees([]);
    setShowDmInviteModal(true);
  }

  async function handleInviteToPrivateChannel() {
    if (!activeChannel?.id || !activeChannel?.is_private || !canManagePrivateChannel) return;
    setShowChannelInviteModal(true);
    setChannelInviteErr('');
    setChannelInviteLoading(true);
    setChannelInviteQuery('');
    setSelectedChannelInvitees([]);
    try {
      const channelMembers = await fetchChannelMembers(activeChannel.id);
      setPrivateChannelMembers(channelMembers);
    } catch (err: any) {
      setChannelInviteErr(err?.message || 'Failed to load channel access list');
      setPrivateChannelMembers([]);
    } finally {
      setChannelInviteLoading(false);
    }
  }

  function searchInviteUsers(value: string) {
    if (inviteDebounceRef.current) clearTimeout(inviteDebounceRef.current);
    const query = value.trim();
    if (!query) {
      setInviteResults([]);
      return;
    }

    inviteDebounceRef.current = setTimeout(async () => {
      try {
        const data = await api.get(`/users?q=${encodeURIComponent(query)}`);
        const users: any[] = data.users ?? data ?? [];
        setInviteResults(users.filter((entry) => !existingDmMemberIds.has(entry.id)));
      } catch {
        setInviteResults([]);
      }
    }, 220);
  }

  function toggleInvitee(user) {
    if (!user?.id) return;
    setSelectedInvitees((prev) => {
      const exists = prev.some((entry) => entry.id === user.id);
      if (exists) return prev.filter((entry) => entry.id !== user.id);
      return [...prev, user];
    });
  }

  function toggleChannelInvitee(member) {
    if (!member?.id) return;
    setSelectedChannelInvitees((prev) => {
      const exists = prev.some((entry) => entry.id === member.id);
      if (exists) return prev.filter((entry) => entry.id !== member.id);
      return [...prev, member];
    });
  }

  function handleInviteInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInviteQuery(e.target.value);
    searchInviteUsers(e.target.value);
  }

  async function submitInviteToDm(e: React.FormEvent) {
    e.preventDefault();
    if (!activeConv?.id || dmInviteBusy) return;

    const selected = selectedInvitees.map((entry) => entry.id).filter(Boolean);
    const typed = inviteQuery
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const participants = selected.length
      ? selected
      : [...new Set(typed)].filter((value) => !existingDmMemberIds.has(value));

    if (!participants.length) {
      setDmActionErr('Select someone from search, or type a username/email/id and press Invite.');
      return;
    }

    setDmInviteBusy(true);
    setDmActionErr('');
    try {
      await inviteToConversation(activeConv.id, participants);
      setShowDmInviteModal(false);
      setInviteQuery('');
      setInviteResults([]);
      setSelectedInvitees([]);
    } catch (err: any) {
      const msg = err?.message || 'Failed to invite participant(s)';
      setDmActionErr(msg);
    } finally {
      setDmInviteBusy(false);
    }
  }

  async function submitInviteToChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!activeChannel?.id || channelInviteBusy || !canManagePrivateChannel) return;

    const userIds = selectedChannelInvitees.map((entry) => entry.id).filter(Boolean);
    if (!userIds.length) {
      setChannelInviteErr('Select at least one community member to add.');
      return;
    }

    setChannelInviteBusy(true);
    setChannelInviteErr('');
    try {
      const updatedMembers = await inviteToChannel(activeChannel.id, userIds);
      setPrivateChannelMembers(updatedMembers);
      setSelectedChannelInvitees([]);
      setChannelInviteQuery('');
    } catch (err: any) {
      setChannelInviteErr(err?.message || 'Failed to add member(s) to private channel');
    } finally {
      setChannelInviteBusy(false);
    }
  }

  function handleLeaveDm() {
    if (!activeConv?.id) return;
    setDmActionErr('');
    setShowDmLeaveModal(true);
  }

  async function confirmLeaveDm() {
    if (!activeConv?.id || dmLeaveBusy) return;
    setDmLeaveBusy(true);
    setDmActionErr('');
    try {
      await leaveConversation(activeConv.id);
      setShowDmLeaveModal(false);
    } catch (err: any) {
      const msg = err?.message || 'Failed to leave conversation';
      setDmActionErr(msg);
    } finally {
      setDmLeaveBusy(false);
    }
  }

  // Infinite scroll – load older messages when scrolled to top
  const handleScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || loadingMore || msgList.length === 0) return;
    if (el.scrollTop < 80) {
      const beforeId = msgList[0]?.id;
      if (!beforeId) return;
      if (exhaustedBeforeRef.current === beforeId) return;
      if (Date.now() < historyRetryAfterRef.current) return;

      setLoadMore(true);
      const prevH = el.scrollHeight;
      try {
        const older = await fetchMessages({
          channelId:      activeChannel?.id,
          conversationId: activeConv?.id,
          before:         beforeId,
        });

        if (!older?.length) {
          exhaustedBeforeRef.current = beforeId;
          return;
        }

        exhaustedBeforeRef.current = null;
        // Restore scroll position after prepend
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevH;
        });
      } catch (err) {
        const status = Number(err?.status || 0);
        if (status === 503) {
          // Temporary backend overload/unavailability: back off to avoid request storms.
          historyRetryAfterRef.current = Date.now() + 5000;
        }
        console.warn('[messages] failed to load older history', err);
      } finally {
        setLoadMore(false);
      }
    }
  }, [loadingMore, msgList, activeChannel, activeConv]);

  const title = activeChannel
    ? `# ${activeChannel.name}`
    : activeConv?.is_group
      ? (activeConv.name || 'Unnamed Group')
      : (activeConv?.name || 'Direct Message');

  // Any activeConv is a DM – we don't need participants.length to gate read receipts.
  const isDm = Boolean(activeConv);
  const otherLastReadMessageId = activeConv?.other_last_read_message_id || activeConv?.otherLastReadMessageId;
  const { latestOwnMessageId, latestOwnSeen } = useMemo(() => {
    let latestOwnId: string | null = null;
    let latestOwnIdx = -1;
    for (let i = msgList.length - 1; i >= 0; i -= 1) {
      const m = msgList[i];
      if (!m?.deleted_at && m?.author_id === user?.id) {
        latestOwnId = m.id;
        latestOwnIdx = i;
        break;
      }
    }

    if (!isDm || !latestOwnId || !otherLastReadMessageId) {
      return { latestOwnMessageId: latestOwnId, latestOwnSeen: false };
    }

    // Fast path: recipient read pointer exactly equals latest outgoing message.
    if (otherLastReadMessageId === latestOwnId) {
      return { latestOwnMessageId: latestOwnId, latestOwnSeen: true };
    }

    const readIdx = msgList.findIndex(m => m.id === otherLastReadMessageId);
    const seen = readIdx >= latestOwnIdx && latestOwnIdx >= 0;
    return {
      latestOwnMessageId: latestOwnId,
      latestOwnSeen: seen,
    };
  }, [msgList, user?.id, isDm, otherLastReadMessageId]);

  const latestVisibleMessage = useMemo(() => {
    for (let i = msgList.length - 1; i >= 0; i -= 1) {
      const m = msgList[i];
      if (!m?.deleted_at) return m;
    }
    return null;
  }, [msgList]);

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
          {activeConv?.is_group && editingName ? (
            <input
              className={styles.nameInput}
              value={draftName}
              autoFocus
              onChange={e => setDraftName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  renameGroupDm(activeConv.id, draftName).catch(() => {});
                  setEditingName(false);
                } else if (e.key === 'Escape') {
                  setEditingName(false);
                }
              }}
              onBlur={() => {
                renameGroupDm(activeConv.id, draftName).catch(() => {});
                setEditingName(false);
              }}
              maxLength={100}
              data-testid="group-dm-name-input"
            />
          ) : (
            <>
              <span className={styles.headerTitle} data-testid="message-pane-title">{title}</span>
              {activeConv?.is_group && (
                <button
                  type="button"
                  className={styles.editNameBtn}
                  onClick={() => {
                    setDraftName(activeConv.name || '');
                    setEditingName(true);
                  }}
                  title="Rename group"
                  data-testid="group-dm-rename-btn"
                >
                  ✏
                </button>
              )}
            </>
          )}
          {activeChannel?.description && (
            <span className={styles.headerDesc}>{activeChannel.description}</span>
          )}
        </div>
        <div className={styles.headerActions}>
          {activeConv && (
            <>
              {activeConv?.is_group && (
                <>
                  <button
                    type="button"
                    className={styles.dmActionBtn}
                    onClick={handleInviteToDm}
                    data-testid="dm-invite-button"
                  >
                    Invite
                  </button>
                  <button
                    type="button"
                    className={`${styles.dmActionBtn} ${styles.dmLeaveBtn}`}
                    onClick={handleLeaveDm}
                    data-testid="dm-leave-button"
                  >
                    Leave
                  </button>
                </>
              )}
            </>
          )}
          {activeChannel?.is_private && canManagePrivateChannel && (
            <button
              type="button"
              className={styles.dmActionBtn}
              onClick={handleInviteToPrivateChannel}
              data-testid="channel-invite-button"
            >
              Add Members
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
              onClick={() => { setSearch(true); }}
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

      <div className={`${styles.body} ${isMemberListResizing ? styles.bodyResizing : ''}`} ref={bodyRef} style={{ '--member-list-width': `${memberListWidth}px` } as CSSProperties}>
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
                showReadReceipt={Boolean(
                  activeConv
                    && latestOwnSeen
                    && latestVisibleMessage
                    && latestVisibleMessage.author_id === user?.id
                    && msg.id === latestVisibleMessage.id
                    && msg.id === latestOwnMessageId
                )}
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

        <div
          className={`${styles.resizeHandle} ${isMemberListResizing ? styles.resizeHandleActive : ''}`}
          role="separator"
          aria-label="Resize member list"
          aria-orientation="vertical"
          aria-valuemin={MIN_MEMBER_LIST_WIDTH}
          aria-valuemax={getMaxMemberListWidth()}
          aria-valuenow={memberListWidth}
          tabIndex={0}
          onPointerDown={startMemberListResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setMemberListWidth((current) => clampMemberListWidth(current + 16));
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              setMemberListWidth((current) => clampMemberListWidth(current - 16));
            }
          }}
          data-testid="member-list-resize-handle"
        />

        {/* Right sidebar (members/search) */}
        {(activeChannel || activeConv) && (
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

      {showDmInviteModal && activeConv && (
        <Modal title="Invite to conversation" onClose={() => { if (!dmInviteBusy) setShowDmInviteModal(false); }}>
          <form className={styles.modalForm} onSubmit={submitInviteToDm} data-testid="dm-invite-modal">
            <label className={styles.modalLabel}>
              Add people
              <input
                className={styles.modalInput}
                ref={inviteInputRef}
                value={inviteQuery}
                onChange={handleInviteInputChange}
                placeholder="Find by name or username…"
                data-testid="dm-invite-input"
              />
            </label>
            {selectedInvitees.length > 0 && (
              <div className={styles.selectedUsers} data-testid="dm-invite-selected-users">
                {selectedInvitees.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    className={styles.selectedUserChip}
                    onClick={() => toggleInvitee(user)}
                  >
                    <span>{user.displayName || user.display_name || user.username}</span>
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}
            {inviteResults.length > 0 && (
              <ul className={styles.inviteResults} data-testid="dm-invite-results">
                {inviteResults.map((user) => (
                  <li key={user.id}>
                    <button
                      type="button"
                      className={styles.inviteResultBtn}
                      onClick={() => toggleInvitee(user)}
                      disabled={dmInviteBusy}
                      data-testid={`dm-invite-user-${user.id}`}
                    >
                      <span className={styles.inviteResultName}>{user.displayName || user.display_name || user.username}</span>
                      {user.username && <span className={styles.inviteResultUsername}>@{user.username}</span>}
                      {selectedInvitees.some((entry) => entry.id === user.id) && <span className={styles.inviteSelectedMark}>Selected</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {inviteQuery.trim() && inviteResults.length === 0 && (
              <p className={styles.modalHint}>No matches yet. You can still type exact username/email/id and press Invite.</p>
            )}
            {dmActionErr && <p className={styles.dmActionErr}>{dmActionErr}</p>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalCancelBtn}
                onClick={() => setShowDmInviteModal(false)}
                disabled={dmInviteBusy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.modalPrimaryBtn}
                disabled={dmInviteBusy || (selectedInvitees.length === 0 && !inviteQuery.trim())}
                data-testid="dm-invite-submit"
              >
                {dmInviteBusy ? 'Inviting…' : selectedInvitees.length > 1 ? 'Invite people' : 'Invite person'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showChannelInviteModal && activeChannel && (
        <Modal title="Add members to private channel" onClose={() => { if (!channelInviteBusy) setShowChannelInviteModal(false); }}>
          <form className={styles.modalForm} onSubmit={submitInviteToChannel} data-testid="channel-invite-modal">
            <label className={styles.modalLabel}>
              Invite community members
              <input
                className={styles.modalInput}
                value={channelInviteQuery}
                onChange={(e) => setChannelInviteQuery(e.target.value)}
                placeholder="Filter by name or username…"
                data-testid="channel-invite-input"
              />
            </label>

            <p className={styles.modalHint}>
              People added here can read and send messages in #{activeChannel.name}.
            </p>

            {privateChannelMembers.length > 0 && (
              <div className={styles.channelAccessSection} data-testid="channel-access-members">
                <div className={styles.channelAccessLabel}>Has access</div>
                <div className={styles.selectedUsers}>
                  {privateChannelMembers.map((member) => (
                    <span key={member.id} className={styles.accessMemberChip}>
                      {member.displayName || member.display_name || member.username}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {selectedChannelInvitees.length > 0 && (
              <div className={styles.selectedUsers} data-testid="channel-invite-selected-users">
                {selectedChannelInvitees.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    className={styles.selectedUserChip}
                    onClick={() => toggleChannelInvitee(member)}
                  >
                    <span>{member.displayName || member.display_name || member.username}</span>
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}

            {channelInviteLoading ? (
              <p className={styles.modalHint}>Loading channel access…</p>
            ) : privateChannelInviteResults.length > 0 ? (
              <ul className={styles.inviteResults} data-testid="channel-invite-results">
                {privateChannelInviteResults.map((member) => {
                  const selected = selectedChannelInvitees.some((entry) => entry.id === member.id);
                  return (
                    <li key={member.id}>
                      <button
                        type="button"
                        className={styles.inviteResultBtn}
                        onClick={() => toggleChannelInvitee(member)}
                        data-testid={`channel-invite-result-${member.id}`}
                      >
                        <span className={styles.inviteResultName}>{member.displayName || member.display_name || member.username}</span>
                        <span className={styles.inviteResultUsername}>@{member.username}</span>
                        {selected && <span className={styles.inviteSelectedMark}>Selected</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.modalHint}>
                {(members || []).length ? 'No additional community members match this filter.' : 'No community members available to invite.'}
              </p>
            )}

            {channelInviteErr && <p className={styles.dmActionErr}>{channelInviteErr}</p>}

            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalCancelBtn}
                onClick={() => setShowChannelInviteModal(false)}
                disabled={channelInviteBusy}
                data-testid="channel-invite-cancel"
              >
                Close
              </button>
              <button
                type="submit"
                className={styles.modalPrimaryBtn}
                disabled={channelInviteBusy || selectedChannelInvitees.length === 0}
                data-testid="channel-invite-submit"
              >
                {channelInviteBusy ? 'Adding…' : 'Add Members'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showDmLeaveModal && activeConv && (
        <Modal title="Leave conversation" onClose={() => { if (!dmLeaveBusy) setShowDmLeaveModal(false); }}>
          <div className={styles.modalForm} data-testid="dm-leave-modal">
            <p className={styles.modalHint}>You will stop receiving messages from this DM.</p>
            {dmActionErr && <p className={styles.dmActionErr}>{dmActionErr}</p>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalCancelBtn}
                onClick={() => setShowDmLeaveModal(false)}
                disabled={dmLeaveBusy}
              >
                Stay
              </button>
              <button
                type="button"
                className={styles.modalDangerBtn}
                onClick={confirmLeaveDm}
                disabled={dmLeaveBusy}
                data-testid="dm-leave-confirm"
              >
                {dmLeaveBusy ? 'Leaving…' : 'Leave'}
              </button>
            </div>
          </div>
        </Modal>
      )}
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
