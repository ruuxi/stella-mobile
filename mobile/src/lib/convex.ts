import { ConvexReactClient } from "convex/react";
import { env } from "../config/env";

/**
 * Singleton Convex React client for the mobile app. We don't run
 * additional Convex queries from the mobile right now — this exists
 * specifically so the chat surface can subscribe reactively to the
 * desktop's reply on `mobile_replies.watchDesktopReply` (driven by the
 * `mobile_chat.sendChat` action). Other mobile data still flows over
 * the existing HTTP routes via `src/lib/http.ts`.
 *
 * Auth wiring is attached separately by `ConvexBetterAuthProvider`,
 * which calls `setAuth(...)` on this client with a JWT fetcher backed
 * by Better Auth's session.
 */
let cachedClient: ConvexReactClient | null = null;

export function getConvexClient(): ConvexReactClient {
  if (cachedClient) return cachedClient;
  if (!env.convexUrl) {
    throw new Error("EXPO_PUBLIC_CONVEX_URL is not configured.");
  }
  cachedClient = new ConvexReactClient(env.convexUrl);
  return cachedClient;
}
