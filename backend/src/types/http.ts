/**
 * Shared HTTP handler types (Express).
 * `authenticate` attaches `req.user` / `req.token` after successful auth.
 */

import type { NextFunction, Request, Response } from "express";

export type AuthTokenUser = {
  id: string;
  username?: string;
  email?: string;
};

export type AuthedRequest = Request & {
  user: AuthTokenUser;
  token?: string;
};

export type AuthedRequestHandler = (
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;
