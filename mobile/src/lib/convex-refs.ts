import {
  anyApi,
  type FunctionReference,
} from "convex/server";

/**
 * Typed handles for the Convex functions we call from the mobile app.
 *
 * The mobile repo doesn't run `convex codegen` against the backend
 * (different repo, no schema source on this side), so we redeclare the
 * `FunctionReference` shapes here and cast through `anyApi` to keep the
 * call sites type-safe even without a generated `api` import.
 *
 * Keep these in sync with `convex/mobile_chat.ts` and
 * `convex/mobile_replies.ts` in `~/projects/stella-backend`.
 */

export type SendChatResult =
  | { kind: "sync"; text: string }
  | { kind: "pending"; requestId: string }
  | { kind: "unavailable"; text: string };

export const mobileSendChatRef = anyApi.mobile_chat.sendChat as FunctionReference<
  "action",
  "public",
  {
    message: string;
    mobileDeviceId: string;
    desktopDeviceId: string;
    pairSecret: string;
  },
  SendChatResult
>;

export const watchDesktopReplyRef = anyApi.mobile_replies
  .watchDesktopReply as FunctionReference<
  "query",
  "public",
  { requestId: string },
  { text: string; createdAt: number } | null
>;

export const acknowledgeDesktopReplyRef = anyApi.mobile_replies
  .acknowledgeDesktopReply as FunctionReference<
  "mutation",
  "public",
  { requestId: string },
  null
>;
