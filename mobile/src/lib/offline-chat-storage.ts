import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage } from "../types";

const OFFLINE_STORAGE_KEY = "stella-mobile-offline-chat-v1";
const COMPUTER_STORAGE_KEY = "stella-mobile-computer-chat-v1";
const MAX_MESSAGES = 200;

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
  return {
    id: o.id,
    role: o.role,
    text: o.text,
    ...(o.hasImage === true ? { hasImage: true } : {}),
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
