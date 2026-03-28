import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import styles from './WelcomePane.module.css';

export default function WelcomePane() {
  const user        = useAuthStore(s => s.user);
  const communities = useChatStore(s => s.communities);

  return (
    <div className={styles.wrap} data-testid="welcome-pane">
      <div className={styles.card} data-testid="welcome-card">
        <div className={styles.mark}>▸</div>
        <h1 className={styles.heading}>
          Welcome back, <span className={styles.name}>{user?.displayName || user?.username}</span>
        </h1>
        <p className={styles.sub}>
          {communities.length === 0
            ? 'Create a community using the + button on the left to get started.'
            : 'Select a channel or DM from the sidebar to start chatting.'}
        </p>

        <div className={styles.hints} data-testid="welcome-hints">
          <Hint icon="▸" label="Select a community on the left" testId="hint-community" />
          <Hint icon="#" label="Pick a channel to open it" testId="hint-channel" />
          <Hint icon="@" label="Open DMs tab for direct messages" testId="hint-dm" />
          <Hint icon="⌕" label="Click the search icon to find messages" testId="hint-search" />
        </div>
      </div>
    </div>
  );
}

function Hint({ icon, label, testId }) {
  return (
    <div className={styles.hint} data-testid={testId}>
      <span className={styles.hintIcon}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}
