import type { ChatMessage } from "../types";

/**
 * Merge canonical desktop messages into the local transcript by id without
 * ever discarding local-only rows (e.g. cloud-answered turns). Rows the
 * transcript already reconciled keep their local id (`canonicalId` links
 * them to the desktop row) so streaming bubbles never remount.
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
      existing ? { ...message, id, canonicalId: message.id } : message,
    );
  }
  return order
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => Boolean(message));
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
      };
    }
    return message;
  });
  return mergeMessagesById(
    next,
    canonicalMessages.filter((message) => !consumed.has(message.id)),
  );
};
