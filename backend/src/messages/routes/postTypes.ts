/**
 * Narrow types for POST /messages (easier refactors than bare `Request`).
 */

import type { Request, Response } from "express";

/** After `authenticate` on the messages router (`body`/`query` come from express + validators). */
export type MessagesAuthedRequest = Request & {
  id?: string;
  user: { id: string };
};

export interface MessagePostBody {
  content?: string;
  channelId?: string | null;
  conversationId?: string | null;
  threadId?: string | null;
  attachments?: unknown;
}

export type MessagePostResponse = Response;
