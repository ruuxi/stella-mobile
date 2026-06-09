import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage } from "../types";
import { parseChatArtifacts } from "./mobile-artifacts";

// The unified chat transcript. The key predates unification (it was the
// cloud-only chat store) and is kept so existing local history carries over.
const CHAT_STORAGE_KEY = "stella-mobile-offline-chat-v1";
const CHAT_SYNC_STATE_KEY = "stella-mobile-chat-sync-state-v1";
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
    role: o.role,
    text: o.text,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(o.hasImage === true ? { hasImage: true } : {}),
    ...(thumbnailUris.length > 0 ? { thumbnailUris } : {}),
    ...(o.cloudFallback === true ? { cloudFallback: true } : {}),
  };
}

export async function loadChatMessages(): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(CHAT_STORAGE_KEY);
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
  messages: ChatMessage[],
): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await AsyncStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
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

export async function loadChatSyncState(): Promise<ChatSyncState> {
  try {
    const raw = await AsyncStorage.getItem(CHAT_SYNC_STATE_KEY);
    if (raw) {
      return normalizeSyncState(JSON.parse(raw) as unknown);
    }
    return { conversationId: null, cursor: null };
  } catch {
    return { conversationId: null, cursor: null };
  }
}

export async function saveChatSyncState(state: ChatSyncState): Promise<void> {
  const next = normalizeSyncState(state);
  if (!next.conversationId && !next.cursor) {
    await AsyncStorage.removeItem(CHAT_SYNC_STATE_KEY);
    return;
  }
  await AsyncStorage.setItem(CHAT_SYNC_STATE_KEY, JSON.stringify(next));
}
