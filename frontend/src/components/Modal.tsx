import { useEffect } from 'react';
import styles from './Modal.module.css';

export default function Modal({ title, onClose, children }) {
  // Close on Escape
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  return (
    <div className={styles.overlay} data-testid="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={title} data-testid="modal-root">
        <div className={styles.header}>
          <span className={styles.title} data-testid="modal-title">{title}</span>
          <button className={styles.close} onClick={onClose} aria-label="Close modal" data-testid="modal-close">✕</button>
        </div>
        <div className={styles.body} data-testid="modal-body">{children}</div>
      </div>
    </div>
  );
}
