import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage } from "../types";
import { parseChatArtifacts } from "./mobile-artifacts";

/**
 * The two independent chat transcripts. The cloud thread keeps the original
 * key (it was the cloud-only store before chat unification) so existing local
 * history stays put; the computer thread gets its own key and re-hydrates from
 * the desktop bridge on mount.
 */
export type ChatThreadId = "cloud" | "computer";

const MESSAGES_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-offline-chat-v1",
  computer: "stella-mobile-computer-chat-v1",
};
const SYNC_STATE_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-chat-sync-state-v1",
  computer: "stella-mobile-computer-sync-state-v1",
};
const MAX_MESSAGES = 1000;

export type ChatSyncState = {
  conversationId: string | null;
  cursor: string | null;
};

function parseRow(row: unknown): ChatMessage | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const o = row as Record<string, unknown>;
  if (typeof o.id !== "string") {
    return null;
  }
  if (o.role !== "user" && o.role !== "assistant") {
    return null;
  }
  if (typeof o.text !== "string") {
    return null;
  }
  const thumbnailUris = Array.isArray(o.thumbnailUris)
    ? o.thumbnailUris.filter((v): v is string => typeof v === "string")
    : [];
  const conversationId =
    typeof o.conversationId === "string" ? o.conversationId : "";
  const artifacts = parseChatArtifacts(o.artifacts, conversationId);
  return {
    id: o.id,
    ...(typeof o.canonicalId === "string" && o.canonicalId.trim()
      ? { canonicalId: o.canonicalId.trim() }
      : {}),
    ...(typeof o.createdAt === "number" && Number.isFinite(o.createdAt)
      ? { createdAt: o.createdAt }
      : {}),
    role: o.role,
    text: o.text,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(o.hasImage === true ? { hasImage: true } : {}),
    ...(thumbnailUris.length > 0 ? { thumbnailUris } : {}),
    ...(o.cloudFallback === true ? { cloudFallback: true } : {}),
  };
}

export async function loadChatMessages(
  thread: ChatThreadId,
): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGES_KEY[thread]);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ChatMessage[] = [];
    for (const item of parsed) {
      const row = parseRow(item);
      if (row) {
        out.push(row);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveChatMessages(
  thread: ChatThreadId,
  messages: ChatMessage[],
): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await AsyncStorage.setItem(MESSAGES_KEY[thread], JSON.stringify(trimmed));
}

const normalizeSyncState = (value: unknown): ChatSyncState => {
  if (!value || typeof value !== "object") {
    return { conversationId: null, cursor: null };
  }
  const record = value as Record<string, unknown>;
  const conversationId =
    typeof record.conversationId === "string"
      ? record.conversationId.trim()
      : "";
  const cursor =
    typeof record.cursor === "string" ? record.cursor.trim() : "";
  return {
    conversationId: conversationId || null,
    cursor: cursor || null,
  };
};

export async function loadChatSyncState(
  thread: ChatThreadId,
): Promise<ChatSyncState> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_STATE_KEY[thread]);
    if (raw) {
      return normalizeSyncState(JSON.parse(raw) as unknown);
    }
    return { conversationId: null, cursor: null };
  } catch {
    return { conversationId: null, cursor: null };
  }
}

export async function saveChatSyncState(
  thread: ChatThreadId,
  state: ChatSyncState,
): Promise<void> {
  const next = normalizeSyncState(state);
  if (!next.conversationId && !next.cursor) {
    await AsyncStorage.removeItem(SYNC_STATE_KEY[thread]);
    return;
  }
  await AsyncStorage.setItem(SYNC_STATE_KEY[thread], JSON.stringify(next));
}
