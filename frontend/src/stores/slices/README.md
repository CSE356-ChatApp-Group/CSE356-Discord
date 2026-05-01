# Store slices

Incremental extractions from `chatStore.ts` live next to the main store:

- `../chatStoreCommunityRemoval.ts` — community delete / cascade state cleanup
- `../chatStoreChannelHelpers.ts`, `../chatStoreStateUtils.ts` — shared helpers

New domain slices should stay **imported by `chatStore.ts` only** until the public `useChatStore` contract is intentionally versioned.
