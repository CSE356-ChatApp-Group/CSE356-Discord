import { useAuthStore } from './authStore';
import type { Entity } from './chatStoreTypes';

export function hydrateAuthorFromSession(message: Entity) {
  if (!message || message.author) return message;

  const currentUser = useAuthStore.getState().user;
  if (!currentUser || message.author_id !== currentUser.id) return message;

  return {
    ...message,
    author: {
      id: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.displayName,
      display_name: currentUser.displayName,
      email: currentUser.email,
    },
  };
}
