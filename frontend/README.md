# ChatApp Frontend

Barebones React + Vite SPA for testing the ChatApp MVP API.

## Stack

- **React 18** with hooks
- **Zustand** for state (auth + chat stores)
- **React Router v6** for navigation
- **date-fns** for timestamps
- **CSS Modules** throughout — no CSS-in-JS dependency
- **Vite** dev server with proxy to backend (no CORS config needed locally)

## Running locally

### Option A — with Docker Compose (recommended)
```bash
# From repo root — starts everything including the frontend dev server
docker compose up -d

# Frontend available at:
open http://localhost:5173
```

### Option B — standalone
```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

The Vite dev server proxies `/api/*` and `/ws` to `http://localhost` (Nginx),
so no CORS issues and no env config needed.

## File map

```
src/
├── main.tsx                   React root mount
├── App.tsx                    Router + auth guard + OAuth callback handler
├── styles.css                 Global CSS variables, resets, animations
│
├── lib/
│   ├── api.ts                 fetch wrapper — auto attaches token, handles 401 refresh
│   └── ws.ts                  WebSocket manager — connect/subscribe/reconnect
│
├── stores/
│   ├── authStore.ts           login / register / logout / session restore
│   └── chatStore.ts           communities, channels, messages, presence, search
│
├── hooks/
│   ├── usePresenceHeartbeat.ts  sends WS presence updates, sets away on tab hide
│   └── useAutoResize.ts         expands textarea as user types
│
└── pages/
    ├── LoginPage.tsx
    ├── RegisterPage.tsx
    ├── Auth.module.css          shared auth page styles
    └── ChatPage.tsx             main layout — composes all sidebar + pane components

components/
├── CommunitySidebar.tsx   leftmost icon strip + create community modal
├── ChannelSidebar.tsx     channel list + DM list + create channel modal
├── MessagePane.tsx        header, scrollable message list, input form
├── MessageItem.tsx        single message with grouping, edit, delete
├── MemberList.tsx         right panel — members grouped by presence status
├── SearchBar.tsx          collapsible search with FTS highlight rendering
├── WelcomePane.tsx        shown when no channel is selected
└── Modal.tsx              reusable overlay modal (Escape to close)
```

## Key behaviours

**Session restore** — on page load, `authStore.init()` tries the existing token then
falls back to a silent cookie-based refresh. The user stays logged in across reloads.

**Real-time messages** — `ws.ts` opens a single WebSocket on login and auto-reconnects.
`chatStore._handleWsEvent` handles `message:created`, `message:updated`,
`message:deleted`, and `presence:updated` events dispatched from Redis Pub/Sub.

**Message grouping** — consecutive messages from the same author within 5 minutes are
visually grouped (no repeated avatar/name), matching Discord/Slack conventions.

**Infinite scroll** — scrolling to the top of the message list fetches the previous 50
messages and restores scroll position using `scrollHeight` diff.

**Presence** — `usePresenceHeartbeat` sends websocket presence events for the active
connection. The backend aggregates all active connections for a user and applies a
1-minute activity window to resolve `online` vs `idle`, while tab hide still
transitions that connection to `away` after 2 minutes.

## LLM Test Navigation Contract

The UI now exposes stable selectors and landmarks so automated LLM test agents can
drive full feature scenarios reliably without brittle CSS/text matching.

Primary page anchors:

- `data-testid="route-login"`
- `data-testid="route-register"`
- `data-testid="route-chat"`
- `data-testid="route-oauth-callback"`

Auth flows:

- Login: `login-form`, `login-email`, `login-password`, `login-submit`
- OAuth sign-in: `oauth-google`, `oauth-github`, `oauth-course`
- Register: `register-form`, `register-email`, `register-username`, `register-password`, `register-submit`
- OAuth account choice: `oauth-mode-create`, `oauth-mode-connect`, `oauth-complete-form`, `oauth-complete-submit`

Chat navigation:

- Community navigation: `community-sidebar`, `community-list`, `community-item-<id>`, `community-create-open`
- Channel/DM navigation: `channel-sidebar`, `tab-channels`, `tab-dms`, `channel-item-<id>`, `dm-item-<id>`
- Main chat region: `chat-main`, `message-pane`, `message-pane-title`, `message-list`

Messaging actions:

- Composer: `message-compose-form`, `message-compose-input`, `message-send`
- Message rows: `message-item-<id>`
- Search: `message-search-toggle`, `search-input`, `search-results`, `search-hit-<id>`

Account/settings:

- Open account modal: `account-open`
- Link providers: `account-link-google`, `account-link-github`, `account-link-course`
- Local password setup/update: `account-password-form`, `account-password-save`
- Logout: `account-logout`

Presence/member checks:

- Members panel: `member-list`, `member-row-<id>` with `data-member-status`

## Production build

```bash
cd frontend
npm run build          # outputs to frontend/dist/
```

Serve `dist/` as static files from Nginx. Uncomment the static `location /` block
in `infrastructure/nginx/nginx.conf` and point it at the built files.
