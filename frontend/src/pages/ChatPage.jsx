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

  return (
    <div className={styles.layout}>
      <CommunitySidebar />
      <ChannelSidebar />
      <main className={styles.main}>
        {hasActive ? <MessagePane /> : <WelcomePane />}
      </main>
      {activeChannel && <MemberList />}
    </div>
  );
}
