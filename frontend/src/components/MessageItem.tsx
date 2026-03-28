import { useState } from 'react';
import { formatDistanceToNow, format, isToday, isYesterday } from 'date-fns';
import { useChatStore } from '../stores/chatStore';
import { Avatar } from './CommunitySidebar';
import styles from './MessageItem.module.css';

/** Groups consecutive messages from the same author within 5 minutes */
function isGrouped(msg, prev) {
  if (!prev) return false;
  if (msg.author_id !== prev.author_id) return false;
  const diff = new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime();
  return diff < 5 * 60 * 1000;
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  if (isToday(d))     return format(d, 'HH:mm');
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`;
  return format(d, 'MMM d, HH:mm');
}

export default function MessageItem({ message: msg, prevMessage, isOwn, showReadReceipt = false }) {
  const { editMessage, deleteMessage } = useChatStore();
  const grouped = isGrouped(msg, prevMessage);

  const [editing,  setEditing]  = useState(false);
  const [draft,    setDraft]    = useState(msg.content || '');
  const [hovering, setHover]    = useState(false);

  async function submitEdit(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    await editMessage(msg.id, draft.trim());
    setEditing(false);
  }

  function cancelEdit() {
    setDraft(msg.content || '');
    setEditing(false);
  }

  const author = msg.author || { displayName: 'Unknown', username: 'unknown' };
  const name   = author.displayName || author.display_name || author.username || author.email || 'Unknown';

  return (
    <div
      className={`${styles.row} ${grouped ? styles.grouped : ''} fade-in`}
      data-testid={`message-item-${msg.id}`}
      data-message-id={msg.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Avatar column */}
      <div className={styles.avatarCol}>
        {!grouped && <Avatar user={author} name={name} size={36} />}
      </div>

      {/* Content column */}
      <div className={styles.content}>
        {!grouped && (
          <div className={styles.meta}>
            <span className={styles.author}>{name}</span>
            <span className={styles.time}>{formatTimestamp(msg.created_at)}</span>
            {msg.edited_at && <span className={styles.edited}>(edited)</span>}
          </div>
        )}

        {editing ? (
          <form onSubmit={submitEdit} className={styles.editForm}>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className={styles.editInput}
              autoFocus
              rows={2}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(e); }
                if (e.key === 'Escape') cancelEdit();
              }}
            />
            <div className={styles.editActions}>
              <button type="button" className={styles.cancelBtn} onClick={cancelEdit}>Cancel</button>
              <button type="submit" className={styles.saveBtn}>Save</button>
            </div>
          </form>
        ) : (
          <>
            {msg.deleted_at ? (
              <span className={styles.deleted}>This message was deleted.</span>
            ) : (
              <p className={styles.text}>{msg.content}</p>
            )}
            {showReadReceipt && !msg.deleted_at && (
              <div
                className={styles.readReceipt}
                data-testid={`message-read-receipt-${msg.id}`}
                data-read-receipt="READ"
                aria-label="Read by recipient"
              >
                Read
              </div>
            )}
            {/* Attachments */}
            {msg.attachments?.length > 0 && (
              <div className={styles.attachments}>
                {msg.attachments.map(a => (
                  <img key={a.id} src={`/api/v1/attachments/${a.id}`} alt={a.filename}
                    className={styles.image} loading="lazy" />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Action toolbar (visible on hover) */}
      {hovering && !msg.deleted_at && isOwn && !editing && (
        <div className={styles.actions}>
          <button className={styles.actionBtn} title="Edit" aria-label="Edit message" onClick={() => { setDraft(msg.content); setEditing(true); }}>
            <EditIcon />
          </button>
          <button className={`${styles.actionBtn} ${styles.danger}`} title="Delete" aria-label="Delete message"
            onClick={() => { if (confirm('Delete this message?')) deleteMessage(msg.id); }}>
            <TrashIcon />
          </button>
        </div>
      )}

      {/* Grouped timestamp on hover */}
      {hovering && grouped && (
        <span className={styles.groupedTime}>{formatTimestamp(msg.created_at)}</span>
      )}
    </div>
  );
}

function EditIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
      <path d="M10 11v6"/><path d="M14 11v6"/>
      <path d="M9 6V4h6v2"/>
    </svg>
  );
}
