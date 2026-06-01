import { getConvexToken } from "./auth-token";
import {
  buildPhoneAccessHeaders,
  getDesktopBridgeStatus,
  requestDesktopConnection,
  type StoredPhoneAccess,
} from "./phone-access";
import type { ChatArtifact, ChatMessage } from "../types";
import { parseChatArtifacts } from "./mobile-artifacts";

const DESKTOP_WAKE_ATTEMPTS = 24;
const DESKTOP_WAKE_RETRY_MS = 1_000;
const BRIDGE_INVOKE_TIMEOUT_MS = 10_000;
const BRIDGE_HEALTH_TIMEOUT_MS = 3_000;
const BRIDGE_SYNC_TIMEOUT_MS = 5_000;
const BRIDGE_RUN_TIMEOUT_MS = 45_000;
const DEFAULT_HISTORY_LIMIT = 100;
const TIME_TAG_PATTERN =
  "(?:1[0-2]|0?[1-9]):[0-5]\\d\\s?(?:AM|PM)(?:,\\s+[A-Za-z]{3}\\s+\\d{1,2})?";
const SYSTEM_REMINDER_OPEN_TAG = "<\\s*system[-_\\s]*reminder\\s*>";
const SYSTEM_REMINDER_CLOSE_TAG = "<\\/\\s*system[-_\\s]*reminder\\s*>";
const SYSTEM_REMINDER_TIME_TAG = `${SYSTEM_REMINDER_OPEN_TAG}\\s*${TIME_TAG_PATTERN}\\s*${SYSTEM_REMINDER_CLOSE_TAG}`;
const FULL_SYSTEM_REMINDER_TAG_RE = new RegExp(
  `^\\s*${SYSTEM_REMINDER_OPEN_TAG}[\\s\\S]*${SYSTEM_REMINDER_CLOSE_TAG}\\s*$`,
  "i",
);
const LEADING_TIME_TAG_RE = new RegExp(
  `^(?:\\[${TIME_TAG_PATTERN}\\]|${SYSTEM_REMINDER_TIME_TAG})\\s*`,
  "i",
);
const TRAILING_TIME_TAG_RE = new RegExp(
  `\\s*\\n\\n(?:\\[${TIME_TAG_PATTERN}\\]|${SYSTEM_REMINDER_TIME_TAG})\\s*$`,
  "i",
);

export type DesktopBridgeConnection = {
  baseUrl: string;
  headers: Record<string, string>;
};

type DesktopBridgeChatArgs = {
  access: StoredPhoneAccess;
  message: string;
  model?: string | null;
  signal?: AbortSignal;
  onArtifacts?: (artifacts: ChatArtifact[]) => void;
};

type DesktopBridgeChatResult = {
  text: string;
  artifacts: ChatArtifact[];
};

export type DesktopBridgeChatSyncResult = {
  conversationId: string;
  conversationChanged: boolean;
  cursor: string | null;
  messages: ChatMessage[];
};

type PendingResponse = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

class BridgeAbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const isNetworkFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to connect")
  );
};

export const normalizeDesktopChatMessageText = (text: string) =>
  FULL_SYSTEM_REMINDER_TAG_RE.test(text)
    ? ""
    : text
        .replace(TRAILING_TIME_TAG_RE, "")
        .replace(LEADING_TIME_TAG_RE, "")
        .trim();

const readBridgeError = async (response: Response) => {
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // use fallback below
  }
  const record = asRecord(parsed);
  const error = asString(record?.error).trim();
  return error || "Desktop bridge request failed.";
};

const toWebSocketUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/bridge/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const canReachBridgeHealth = async (baseUrl: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/bridge/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export async function resolveDesktopBridge(
  access: StoredPhoneAccess,
): Promise<DesktopBridgeConnection> {
  await requestDesktopConnection(access);

  let baseUrl = "";
  let lastCandidateUrl = "";
  for (let attempt = 0; attempt < DESKTOP_WAKE_ATTEMPTS; attempt += 1) {
    const status = await getDesktopBridgeStatus(access.desktopDeviceId);
    const firstUrl = status.baseUrls.find((url) => url.trim().length > 0);
    if (status.available && firstUrl) {
      const candidateUrl = trimTrailingSlash(firstUrl);
      lastCandidateUrl = candidateUrl;
      if (await canReachBridgeHealth(candidateUrl)) {
        baseUrl = candidateUrl;
        break;
      }
    }
    if (attempt < DESKTOP_WAKE_ATTEMPTS - 1) {
      await sleep(DESKTOP_WAKE_RETRY_MS);
    }
  }

  // Prefer a health-confirmed URL, but if the desktop advertised one and the
  // probe never passed (e.g. an older desktop without /bridge/health, or a slow
  // edge), try it anyway rather than blocking the user.
  if (!baseUrl && lastCandidateUrl) {
    baseUrl = lastCandidateUrl;
  }

  if (!baseUrl) {
    throw new Error(
      "Your desktop is offline right now. Open Stella on your desktop and try again.",
    );
  }

  const token = await getConvexToken();
  return {
    baseUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      ...buildPhoneAccessHeaders(access),
    },
  };
}

export async function invokeDesktopBridge<T>(
  bridge: DesktopBridgeConnection,
  channel: string,
  args: unknown[] = [],
  timeoutMs = BRIDGE_INVOKE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${bridge.baseUrl}/bridge/ipc/${encodeURIComponent(channel)}`,
      {
        method: "POST",
        headers: {
          ...bridge.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ args }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(await readBridgeError(response));
    }
    const parsed = (await response.json()) as { result?: T };
    return parsed.result as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Desktop bridge request timed out.");
    }
    if (isNetworkFailure(error)) {
      throw new Error(
        "Could not reach your desktop tunnel. Keep Stella open on your desktop and try again.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getDesktopBridgeConversationId(
  bridge: DesktopBridgeConnection,
  timeoutMs = BRIDGE_INVOKE_TIMEOUT_MS,
): Promise<string> {
  const uiState = asRecord(
    await invokeDesktopBridge(bridge, "ui:getState", [], timeoutMs),
  );
  const activeConversationId = asString(uiState?.conversationId).trim();
  if (activeConversationId) {
    return activeConversationId;
  }

  const fallbackConversationId = asString(
    await invokeDesktopBridge(
      bridge,
      "localChat:getOrCreateDefaultConversationId",
      [],
      timeoutMs,
    ),
  ).trim();
  if (!fallbackConversationId) {
    throw new Error("Could not find your desktop chat.");
  }
  return fallbackConversationId;
}

async function listDesktopBridgeMessages(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  maxMessages: number,
): Promise<ChatMessage[]> {
  const rows = await invokeDesktopBridge<unknown[]>(
    bridge,
    "localChat:listSyncMessages",
    [{ conversationId, maxMessages }],
  );
  return parseDesktopBridgeMessageRows(rows, conversationId);
}

function parseDesktopBridgeMessageRows(
  rows: unknown[],
  conversationId: string,
): ChatMessage[] {
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(asRecord(row)))
    .map((row) => {
      const record = row as Record<string, unknown>;
      const id = asString(record.localMessageId).trim();
      const role = record.role;
      const text = normalizeDesktopChatMessageText(asString(record.text));
      const artifacts = parseChatArtifacts(record.artifacts, conversationId);
      if (
        !id ||
        (role !== "user" && role !== "assistant") ||
        (!text && artifacts.length === 0)
      ) {
        return null;
      }
      return {
        id,
        role,
        text,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    })
    .filter((message): message is ChatMessage => Boolean(message));
}

export async function loadDesktopBridgeChatMessages(
  access: StoredPhoneAccess,
  maxMessages = DEFAULT_HISTORY_LIMIT,
): Promise<ChatMessage[]> {
  const bridge = await resolveDesktopBridge(access);
  const conversationId = await getDesktopBridgeConversationId(bridge);
  return await listDesktopBridgeMessages(bridge, conversationId, maxMessages);
}

export async function syncDesktopBridgeChatMessages({
  access,
  expectedConversationId,
  sinceCursor,
  maxMessages = DEFAULT_HISTORY_LIMIT,
}: {
  access: StoredPhoneAccess;
  expectedConversationId?: string | null;
  sinceCursor?: string | null;
  maxMessages?: number;
}): Promise<DesktopBridgeChatSyncResult> {
  const bridge = await resolveDesktopBridge(access);
  const conversationId = await getDesktopBridgeConversationId(
    bridge,
    BRIDGE_SYNC_TIMEOUT_MS,
  );
  const expected = expectedConversationId?.trim() || null;
  const conversationChanged = Boolean(
    expected && expected !== conversationId,
  );
  const effectiveCursor = conversationChanged ? null : sinceCursor;
  const result = asRecord(
    await invokeDesktopBridge(
      bridge,
      "localChat:syncMessages",
      [
        {
          conversationId,
          sinceCursor: effectiveCursor ?? null,
          maxMessages,
        },
      ],
      BRIDGE_SYNC_TIMEOUT_MS,
    ),
  );
  const rows = Array.isArray(result?.messages) ? result.messages : [];
  const cursor = asString(result?.cursor).trim() || effectiveCursor || null;
  return {
    conversationId,
    conversationChanged,
    cursor,
    messages: parseDesktopBridgeMessageRows(rows, conversationId),
  };
}

type HeaderWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

function openBridgeWebSocket(
  bridge: DesktopBridgeConnection,
  signal?: AbortSignal,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeAbortError());
      return;
    }

    const WebSocketWithHeaders =
      WebSocket as unknown as HeaderWebSocketConstructor;
    const ws = new WebSocketWithHeaders(toWebSocketUrl(bridge.baseUrl), null, {
      headers: bridge.headers,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Could not connect to your desktop."));
      ws.close();
    }, BRIDGE_INVOKE_TIMEOUT_MS);

    let onAbort = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      ws.close();
    };
    onAbort = () => fail(new BridgeAbortError());

    signal?.addEventListener("abort", onAbort);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };
    ws.onerror = () => fail(new Error("Could not connect to your desktop."));
    ws.onclose = () => fail(new Error("Desktop bridge disconnected."));
  });
}

function createBridgeSocketClient(
  ws: WebSocket,
  onEvent: (channel: string, data: unknown) => void,
) {
  const pending = new Map<string, PendingResponse>();

  ws.onmessage = (event) => {
    let message: unknown = null;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const record = asRecord(message);
    if (!record) return;

    if (record.type === "event") {
      const channel = asString(record.channel);
      if (channel) {
        onEvent(channel, record.data);
      }
      return;
    }

    if (record.type !== "response") return;
    const id = asString(record.id);
    if (!id) return;
    const callback = pending.get(id);
    if (!callback) return;
    pending.delete(id);
    clearTimeout(callback.timer);
    const error = asString(record.error).trim();
    if (error) {
      callback.reject(new Error(error));
      return;
    }
    callback.resolve(record.result);
  };

  ws.onclose = () => {
    for (const callback of pending.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error("Desktop bridge disconnected."));
    }
    pending.clear();
  };

  const send = (payload: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("Desktop bridge disconnected.");
    }
    ws.send(JSON.stringify(payload));
  };

  return {
    subscribe(channel: string) {
      send({ type: "subscribe", channel });
    },
    invoke<T>(
      channel: string,
      args: unknown[] = [],
      timeoutMs = BRIDGE_INVOKE_TIMEOUT_MS,
    ): Promise<T> {
      const id = `mobile:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Desktop bridge request timed out."));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        try {
          send({ type: "invoke", id, channel, args });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      ws.close();
    },
  };
}

async function readLatestAssistantMessage(
  bridge: DesktopBridgeConnection,
  conversationId: string,
): Promise<ChatMessage | null> {
  const messages = await listDesktopBridgeMessages(
    bridge,
    conversationId,
    DEFAULT_HISTORY_LIMIT,
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      (message.text.trim() || (message.artifacts?.length ?? 0) > 0)
    ) {
      return message;
    }
  }
  return null;
}

export async function sendDesktopBridgeChat({
  access,
  message,
  model,
  signal,
  onArtifacts,
}: DesktopBridgeChatArgs): Promise<DesktopBridgeChatResult> {
  const text = message.trim();
  if (!text) {
    throw new Error("Message is required.");
  }

  const bridge = await resolveDesktopBridge(access);
  const conversationId = await getDesktopBridgeConversationId(bridge);
  const ws = await openBridgeWebSocket(bridge, signal);
  let runId = "";
  let requestId = "";
  let settled = false;
  let closeClient = () => {
    ws.close();
  };
  let cancelRun = () => {};
  const artifactById = new Map<string, ChatArtifact>();
  const mergeArtifacts = (artifacts: ChatArtifact[]) => {
    let changed = false;
    for (const artifact of artifacts) {
      if (artifactById.has(artifact.id)) continue;
      artifactById.set(artifact.id, artifact);
      changed = true;
    }
    if (changed) {
      onArtifacts?.([...artifactById.values()]);
    }
  };

  const finish = async (
    resolve: (value: DesktopBridgeChatResult) => void,
    reject: (reason?: unknown) => void,
    event: Record<string, unknown>,
  ) => {
    if (settled) return;
    settled = true;
    const outcome = asString(event.outcome);
    const error = asString(event.error).trim() || asString(event.reason).trim();
    if (outcome === "canceled") {
      reject(new BridgeAbortError());
      return;
    }
    if (error) {
      reject(new Error(error));
      return;
    }
    let finalText = asString(event.finalText).trim();
    let latestAssistant: ChatMessage | null = null;
    if (!finalText || artifactById.size === 0) {
      try {
        latestAssistant = await readLatestAssistantMessage(
          bridge,
          conversationId,
        );
      } catch {
        latestAssistant = null;
      }
    }
    if (!finalText) {
      finalText = latestAssistant?.text.trim() ?? "";
    }
    mergeArtifacts(latestAssistant?.artifacts ?? []);
    finalText = normalizeDesktopChatMessageText(finalText);
    resolve({
      text:
        finalText ||
        (artifactById.size > 0
          ? ""
          : "Stella finished, but did not return a message. Check the desktop app."),
      artifacts: [...artifactById.values()],
    });
  };

  try {
    const result = await new Promise<DesktopBridgeChatResult>(
      async (resolve, reject) => {
        let onAbort = () => {};
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const resolveOnce = (value: DesktopBridgeChatResult) => {
          cleanup();
          resolve(value);
        };
        const rejectOnce = (reason?: unknown) => {
          cleanup();
          reject(reason);
        };
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cancelRun();
          rejectOnce(
            new Error("Stella did not reply in time. Try again in a moment."),
          );
        }, BRIDGE_RUN_TIMEOUT_MS);
        onAbort = () => {
          if (settled) return;
          settled = true;
          cancelRun();
          rejectOnce(new BridgeAbortError());
        };

        signal?.addEventListener("abort", onAbort);

        const socketClient = createBridgeSocketClient(ws, (channel, data) => {
          if (channel === "display:update") {
            mergeArtifacts(parseChatArtifacts([data], conversationId));
            return;
          }
          if (channel !== "agent:event") return;
          const event = asRecord(data);
          if (!event) return;

          const eventConversationId = asString(event.conversationId);
          if (eventConversationId && eventConversationId !== conversationId) {
            return;
          }

          const eventRequestId = asString(event.requestId);
          const eventRunId = asString(event.runId);
          if (requestId && eventRequestId && eventRequestId !== requestId) {
            return;
          }
          if (runId && eventRunId && eventRunId !== runId) {
            return;
          }
          if (!requestId && eventRequestId) {
            requestId = eventRequestId;
          }
          if (!runId && eventRunId) {
            runId = eventRunId;
          }

          if (event.type === "run-finished") {
            void finish(resolveOnce, rejectOnce, event);
          }
        });
        closeClient = () => socketClient.close();
        cancelRun = () => {
          if (runId) {
            void socketClient
              .invoke("agent:cancelChat", [runId])
              .catch(() => {});
          }
        };
        socketClient.subscribe("agent:event");
        socketClient.subscribe("display:update");

        try {
          const startResult = asRecord(
            await socketClient.invoke(
              "agent:startChat",
              [
                {
                  conversationId,
                  userPrompt: text,
                  deviceId: access.mobileDeviceId,
                  platform: "mobile",
                  mode: "computer",
                  storageMode: "local",
                  messageMetadata: {
                    source: "stella_mobile",
                    ...(model?.trim()
                      ? { mobileModelPreference: model.trim() }
                      : {}),
                  },
                },
              ],
              BRIDGE_INVOKE_TIMEOUT_MS,
            ),
          );
          requestId = asString(startResult?.requestId).trim() || requestId;
        } catch (error) {
          if (!settled) {
            settled = true;
            rejectOnce(error);
          }
        }
      },
    );
    return result;
  } finally {
    closeClient();
  }
}
