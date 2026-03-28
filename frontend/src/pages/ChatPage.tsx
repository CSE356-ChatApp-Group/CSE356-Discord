import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore }  from '../stores/authStore';
import { usePresenceHeartbeat } from '../hooks/usePresenceHeartbeat';
import CommunitySidebar  from '../components/CommunitySidebar';
import ChannelSidebar    from '../components/ChannelSidebar';
import MessagePane       from '../components/MessagePane';
import MemberList        from '../components/MemberList';
import WelcomePane       from '../components/WelcomePane';
import styles from './ChatPage.module.css';

export default function ChatPage() {
  const { fetchCommunities, fetchConversations, activeChannel, activeConv } = useChatStore();
  usePresenceHeartbeat();

  useEffect(() => {
    fetchCommunities();
    fetchConversations();
  }, []);

  const hasActive = activeChannel || activeConv;
  const showMemberList = Boolean(activeChannel);

  return (
    <div className={`${styles.layout} ${showMemberList ? styles.layoutWithMembers : ''}`} data-testid="page-chat">
      <CommunitySidebar />
      <ChannelSidebar />
      <main className={styles.main} role="main" aria-label="Chat workspace" data-testid="chat-main">
        {hasActive ? <MessagePane /> : <WelcomePane />}
      </main>
      {showMemberList && <MemberList />}
    </div>
  );
}
