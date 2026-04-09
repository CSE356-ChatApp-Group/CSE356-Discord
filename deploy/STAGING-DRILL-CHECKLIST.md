# Staging drill checklist (~15 minutes)

Run after risky deploys or before demos. Staging base URL: use your `STAGING_HOST` / course staging URL.

## Auth

- [ ] Register a throwaway user (or login with test account)
- [ ] Log out and log back in
- [ ] Optional: OAuth / course link path if enabled

## Communities and channels

- [ ] Create or open a community
- [ ] Open a public channel; send a message
- [ ] Open search; query a phrase you just sent

## Direct messages

- [ ] Start or open a 1:1 DM; send and receive
- [ ] Optional: group DM invite / leave if you rely on that flow

## Realtime

- [ ] With two browsers or incognito + normal: message in channel appears without manual refresh

## Attachments (if MinIO/S3 enabled)

- [ ] Upload a small image on a message; it renders

## Health

- [ ] `GET /health` on API returns 200
- [ ] No sustained 5xx in browser network tab during the drill

## Sign-off

Record date, git SHA deployed, and initials. If any box fails, file an issue and link [`docs/RUNBOOKS.md`](../docs/RUNBOOKS.md).
