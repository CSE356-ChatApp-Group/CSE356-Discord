import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import styles from './WelcomePane.module.css';

export default function WelcomePane() {
  const user        = useAuthStore(s => s.user);
  const communities = useChatStore(s => s.communities);

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.mark}>▸</div>
        <h1 className={styles.heading}>
          Welcome back, <span className={styles.name}>{user?.displayName || user?.username}</span>
        </h1>
        <p className={styles.sub}>
          {communities.length === 0
            ? 'Create a community using the + button on the left to get started.'
            : 'Select a channel or DM from the sidebar to start chatting.'}
        </p>

        <div className={styles.hints}>
          <Hint icon="▸" label="Select a community on the left" />
          <Hint icon="#" label="Pick a channel to open it" />
          <Hint icon="@" label="Open DMs tab for direct messages" />
          <Hint icon="⌕" label="Click the search icon to find messages" />
        </div>
      </div>
    </div>
  );
}

function Hint({ icon, label }) {
  return (
    <div className={styles.hint}>
      <span className={styles.hintIcon}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}
