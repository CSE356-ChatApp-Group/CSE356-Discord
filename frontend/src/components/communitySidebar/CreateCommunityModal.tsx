import { useState, type FormEvent } from 'react';
import Modal from '../Modal';
import styles from '../CommunitySidebar.module.css';

export default function CreateCommunityModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (slug: string, name: string, description: string) => Promise<void>;
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  function getCreateCommunityErrorMessage(error: any) {
    const details = Array.isArray(error?.errors) ? error.errors : [];
    const first = details[0];
    const path = first?.path || first?.param;
    if (path === 'slug') return 'Community slug is required.';
    if (path === 'name') return 'Community name is required.';
    if (path === 'description') return 'Description must be text.';
    return error?.message || 'Could not create community.';
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedDesc = desc.trim();
    const trimmedSlug = (slug || name).trim();
    if (!trimmedName) {
      setErr('Community name is required.');
      return;
    }
    if (!trimmedSlug) {
      setErr('Community slug is required.');
      return;
    }

    setBusy(true);
    setErr('');
    try {
      await onCreate(trimmedSlug, trimmedName, trimmedDesc);
    } catch (e: unknown) {
      setErr(getCreateCommunityErrorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="New Community" onClose={onClose}>
      {err && <p className={styles.err} role="alert">{err}</p>}
      <form onSubmit={submit} className={styles.form} data-testid="community-create-form">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            data-testid="community-create-name"
          />
        </label>
        <label>
          Slug
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
            data-testid="community-create-slug"
          />
        </label>
        <label>
          Description
          <input value={desc} onChange={(e) => setDesc(e.target.value)} data-testid="community-create-description" />
        </label>
        <button type="submit" disabled={busy} data-testid="community-create-submit">{busy ? 'Creating…' : 'Create'}</button>
      </form>
    </Modal>
  );
}
