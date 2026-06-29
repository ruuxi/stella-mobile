import type { ChatMessage } from "../types";

/**
 * Order the transcript by `createdAt` so a synced row lands in its true
 * chronological slot rather than wherever it happened to be appended. The sort
 * is stable (original index breaks ties) and tolerant of legacy rows that
 * predate `createdAt`: a missing timestamp carries forward from the previous
 * row, keeping un-stamped history anchored to its neighbours instead of
 * collapsing to the top.
 */
const sortByCreatedAt = (messages: ChatMessage[]): ChatMessage[] => {
  let lastSeen = 0;
  const keyed = messages.map((message, index) => {
    const createdAt =
      typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
        ? message.createdAt
        : lastSeen;
    lastSeen = createdAt;
    return { message, index, createdAt };
  });
  keyed.sort((a, b) =>
    a.createdAt === b.createdAt ? a.index - b.index : a.createdAt - b.createdAt,
  );
  return keyed.map((entry) => entry.message);
};

/**
 * Merge canonical desktop messages into the local transcript by id without ever
 * discarding local-only rows (e.g. cloud-answered turns). Rows the transcript
 * already reconciled keep their local id (`canonicalId` links them to the
 * desktop row) so streaming bubbles never remount.
 *
 * Matching is strictly by id / `canonicalId`. Content (role+text) is
 * deliberately NOT used to link rows here: this generic sync can't tell an
 * unsent optimistic bubble apart from an older message that merely repeats the
 * same text (e.g. a second "ok"), so a text match could overwrite the bubble
 * with stale history and move it by an old timestamp. Precise optimistic ↔
 * canonical linking for a just-sent turn is `reconcileSentDesktopTurn`'s job,
 * where the specific row ids are known. The result is sorted by `createdAt` so
 * freshly-synced history slots in chronologically instead of at the tail.
 */
export const mergeMessagesById = (
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  const order = current.map((message) => message.id);
  for (const message of incoming) {
    const existing = current.find(
      (candidate) =>
        candidate.id === message.id || candidate.canonicalId === message.id,
    );
    const id = existing?.id ?? message.id;
    if (!byId.has(id)) {
      order.push(id);
    }
    byId.set(
      id,
      existing
        ? {
            ...message,
            id,
            canonicalId: message.id,
            // Keep the timestamp the row was first shown with. Canonical rows
            // carry the *desktop* clock; adopting it for a row that's already
            // on screen lets the re-sort below yank it out of place when the
            // two devices' clocks disagree. New rows (no `existing`) still slot
            // by their canonical time.
            createdAt: existing.createdAt ?? message.createdAt,
            // The canonical desktop row drops attachment thumbnails — keep any
            // the local bubble already has so it doesn't lose its images.
            ...(existing.thumbnailUris?.length && !message.thumbnailUris?.length
              ? { thumbnailUris: existing.thumbnailUris, hasImage: true }
              : {}),
          }
        : message,
    );
  }
  const merged = order
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => Boolean(message));
  return sortByCreatedAt(merged);
};

/**
 * After a phone-sent desktop turn completes, swap the optimistic local user
 * bubble and streamed reply for their canonical desktop rows (keeping local
 * ids stable), then merge any other turns that happened on the desktop.
 */
export const reconcileSentDesktopTurn = ({
  current,
  userMessageId,
  replyId,
  sentText,
  canonicalMessages,
}: {
  current: ChatMessage[];
  userMessageId: string;
  replyId: string;
  sentText: string;
  canonicalMessages: ChatMessage[];
}): ChatMessage[] => {
  const canonicalUser =
    canonicalMessages.find(
      (message) => message.role === "user" && message.text.trim() === sentText,
    ) ?? canonicalMessages.find((message) => message.role === "user");
  const canonicalAssistant = [...canonicalMessages]
    .reverse()
    .find((message) => message.role === "assistant");
  const consumed = new Set<string>();
  const next = current.map((message) => {
    if (message.id === userMessageId && canonicalUser) {
      consumed.add(canonicalUser.id);
      return {
        ...canonicalUser,
        id: message.id,
        canonicalId: canonicalUser.id,
        // Anchor to the optimistic send time so the just-sent turn keeps the
        // position it streamed into, rather than re-sorting onto the desktop
        // clock (which can jump it above earlier messages mid-render).
        createdAt: message.createdAt ?? canonicalUser.createdAt,
        // The canonical desktop row drops attachment thumbnails — keep the
        // ones the user just attached so the bubble doesn't lose its images.
        ...(message.thumbnailUris?.length
          ? { thumbnailUris: message.thumbnailUris, hasImage: true }
          : {}),
      };
    }
    if (message.id === replyId && canonicalAssistant) {
      consumed.add(canonicalAssistant.id);
      return {
        ...canonicalAssistant,
        id: message.id,
        canonicalId: canonicalAssistant.id,
        // Keep the reply pinned where it streamed in; see the user row above.
        createdAt: message.createdAt ?? canonicalAssistant.createdAt,
      };
    }
    return message;
  });
  return mergeMessagesById(
    next,
    canonicalMessages.filter((message) => !consumed.has(message.id)),
  );
};
