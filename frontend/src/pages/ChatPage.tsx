import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useChatStore } from '../stores/chatStore';
import { usePresenceHeartbeat } from '../hooks/usePresenceHeartbeat';
import CommunitySidebar  from '../components/CommunitySidebar';
import ChannelSidebar    from '../components/ChannelSidebar';
import MessagePane       from '../components/MessagePane';
import WelcomePane       from '../components/WelcomePane';
import styles from './ChatPage.module.css';

const DEFAULT_SIDEBAR_WIDTH = 248;
const MIN_SIDEBAR_WIDTH = 140;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STORAGE_KEY = 'chatapp.channelSidebarWidth';

function getMaxSidebarWidth() {
  if (typeof window === 'undefined') return MAX_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.45)));
}

function clampSidebarWidth(width: number) {
  return Math.min(getMaxSidebarWidth(), Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getInitialSidebarWidth() {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH;
  const stored = Number.parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || '', 10);
  if (Number.isFinite(stored)) return clampSidebarWidth(stored);
  return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
}

export default function ChatPage() {
  const {
    fetchCommunities,
    fetchConversations,
    activeChannel,
    activeConv,
  } = useChatStore();
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  usePresenceHeartbeat();

  useEffect(() => {
    fetchCommunities();
    fetchConversations();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const hasActive = activeChannel || activeConv;

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    setIsResizing(true);

    const updateWidth = (clientX: number) => {
      const layoutLeft = layoutRef.current?.getBoundingClientRect().left ?? 0;
      const communityRailWidth = window.innerWidth <= 1200 ? 64 : 72;
      const nextWidth = clampSidebarWidth(clientX - layoutLeft - communityRailWidth);
      setSidebarWidth(nextWidth);
    };

    updateWidth(event.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    const finishResize = () => {
      setIsResizing(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
  }

  const layoutStyle = {
    '--channel-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <div ref={layoutRef} className={`${styles.layout} ${isResizing ? styles.layoutResizing : ''}`} style={layoutStyle} data-testid="page-chat">
      <CommunitySidebar />
      <div className={styles.channelColumn}>
        <ChannelSidebar />
        <div
          className={`${styles.resizeHandle} ${isResizing ? styles.resizeHandleActive : ''}`}
          role="separator"
          aria-label="Resize channel sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={getMaxSidebarWidth()}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setSidebarWidth((current) => clampSidebarWidth(current - 16));
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              setSidebarWidth((current) => clampSidebarWidth(current + 16));
            }
          }}
          data-testid="channel-sidebar-resize-handle"
        />
      </div>
      <main className={styles.main} role="main" aria-label="Chat workspace" data-testid="chat-main">
        {hasActive ? <MessagePane /> : <WelcomePane />}
      </main>
    </div>
  );
}
