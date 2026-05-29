import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage } from "../types";
import { parseChatArtifacts } from "./mobile-artifacts";

const OFFLINE_STORAGE_KEY = "stella-mobile-offline-chat-v1";
const COMPUTER_STORAGE_KEY = "stella-mobile-computer-chat-v1";
const COMPUTER_SYNC_CURSOR_KEY = "stella-mobile-computer-chat-sync-cursor-v1";
const COMPUTER_SYNC_STATE_KEY = "stella-mobile-computer-chat-sync-state-v1";
const MAX_MESSAGES = 200;

export type ComputerChatSyncState = {
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
    role: o.role,
    text: o.text,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(o.hasImage === true ? { hasImage: true } : {}),
    ...(thumbnailUris.length > 0 ? { thumbnailUris } : {}),
  };
}

async function loadMessages(storageKey: string): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
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

async function saveMessages(
  storageKey: string,
  messages: ChatMessage[],
): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await AsyncStorage.setItem(storageKey, JSON.stringify(trimmed));
}

export const loadOfflineChatMessages = () => loadMessages(OFFLINE_STORAGE_KEY);
export const saveOfflineChatMessages = (messages: ChatMessage[]) =>
  saveMessages(OFFLINE_STORAGE_KEY, messages);

export const loadComputerChatMessages = () =>
  loadMessages(COMPUTER_STORAGE_KEY);
export const saveComputerChatMessages = (messages: ChatMessage[]) =>
  saveMessages(COMPUTER_STORAGE_KEY, messages);

const normalizeSyncState = (value: unknown): ComputerChatSyncState => {
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

export async function loadComputerChatSyncState(): Promise<ComputerChatSyncState> {
  try {
    const raw = await AsyncStorage.getItem(COMPUTER_SYNC_STATE_KEY);
    if (raw) {
      return normalizeSyncState(JSON.parse(raw) as unknown);
    }
    const legacyCursor = await AsyncStorage.getItem(COMPUTER_SYNC_CURSOR_KEY);
    if (legacyCursor) {
      await AsyncStorage.removeItem(COMPUTER_SYNC_CURSOR_KEY);
    }
    return { conversationId: null, cursor: null };
  } catch {
    return { conversationId: null, cursor: null };
  }
}

export async function saveComputerChatSyncState(
  state: ComputerChatSyncState,
): Promise<void> {
  const next = normalizeSyncState(state);
  if (!next.conversationId && !next.cursor) {
    await AsyncStorage.removeItem(COMPUTER_SYNC_STATE_KEY);
    await AsyncStorage.removeItem(COMPUTER_SYNC_CURSOR_KEY);
    return;
  }
  await AsyncStorage.setItem(COMPUTER_SYNC_STATE_KEY, JSON.stringify(next));
  await AsyncStorage.removeItem(COMPUTER_SYNC_CURSOR_KEY);
}
