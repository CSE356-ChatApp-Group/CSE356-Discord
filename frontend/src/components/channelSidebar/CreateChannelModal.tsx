import { useState, type FormEvent } from 'react';
import Modal from '../Modal';
import styles from '../ChannelSidebar.module.css';

export default function CreateChannelModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, isPrivate: boolean) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await onCreate(name, isPrivate);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <Modal title="New Channel" onClose={onClose}>
      {err && <p className={styles.err} role="alert">{err}</p>}
      <form onSubmit={submit} className={styles.form} data-testid="channel-create-form">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
            required
            placeholder="e.g. general"
            data-testid="channel-create-name"
          />
        </label>
        <div className={styles.formToggle}>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setPrivate(e.target.checked)}
              data-testid="channel-create-private"
            />
            Private channel
          </label>
        </div>
        <button type="submit" disabled={busy} data-testid="channel-create-submit">
          {busy ? 'Creating…' : 'Create channel'}
        </button>
      </form>
    </Modal>
  );
}
