import {
  BRIDGE_CRYPTO_PROTOCOL,
  createBridgeKeyPair,
  decryptBridgePayload,
  deriveBridgeCryptoSession,
  encryptBridgePayload,
  isBridgeEncryptedEnvelope,
  type BridgeCryptoSession,
} from "./bridge-crypto";
import {
  buildPhonePairProofHeaders,
  getDesktopBridgeStatus,
  requestDesktopConnection,
  type StoredPhoneAccess,
} from "./phone-access";
import { postJson } from "./http";
import type { ChatArtifact, ChatMessage } from "../types";
import { parseChatArtifacts } from "./mobile-artifacts";

const DESKTOP_WAKE_ATTEMPTS = 5;
const DESKTOP_WAKE_RETRY_MS = 3_000;
const BRIDGE_INVOKE_TIMEOUT_MS = 10_000;
const BRIDGE_HEALTH_TIMEOUT_MS = 3_000;
const BRIDGE_SYNC_TIMEOUT_MS = 5_000;
/**
 * Max stretch of silence (no agent events) before we give up on a run. The
 * desktop keeps the run alive across socket drops, so we reset this on every
 * event and on every successful reconnect rather than treating it as a hard
 * wall-clock deadline.
 */
const BRIDGE_RUN_TIMEOUT_MS = 45_000;
const BRIDGE_RECONNECT_MAX_ATTEMPTS = 4;
const BRIDGE_RECONNECT_BASE_DELAY_MS = 400;
const BRIDGE_RECONNECT_MAX_DELAY_MS = 4_000;
const DEFAULT_HISTORY_LIMIT = 100;
const DEVELOPER_RESOURCE_PREVIEWS_KEY = "stella-developer-resource-previews";
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
  crypto: BridgeCryptoSession;
  includeDeveloperArtifacts: boolean;
};

type DesktopBridgeChatArgs = {
  access: StoredPhoneAccess;
  message: string;
  model?: string | null;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onArtifacts?: (artifacts: ChatArtifact[]) => void;
};

type DesktopBridgeChatResult = {
  text: string;
  artifacts: ChatArtifact[];
};

type DesktopBridgeMessage = ChatMessage & {
  requestId?: string;
  timestamp?: number;
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

type DesktopBridgeChallenge = {
  challengeId: string;
  challenge: string;
  desktopDeviceId: string;
  desktopPublicKey: string;
  protocol: string;
};

type DesktopBridgeSessionResponse = {
  sessionId: string;
  sessionSecret: string;
  expiresAt: number;
  desktopPublicKey: string;
  protocol: string;
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

const readBridgeChallenge = async (
  baseUrl: string,
): Promise<DesktopBridgeChallenge> => {
  const response = await fetch(`${baseUrl}/bridge/challenge`, {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(await readBridgeError(response));
  }
  const record = asRecord(await response.json());
  const challenge = {
    challengeId: asString(record?.challengeId).trim(),
    challenge: asString(record?.challenge).trim(),
    desktopDeviceId: asString(record?.desktopDeviceId).trim(),
    desktopPublicKey: asString(record?.desktopPublicKey).trim(),
    protocol: asString(record?.protocol).trim(),
  };
  if (
    !challenge.challengeId ||
    !challenge.challenge ||
    !challenge.desktopDeviceId ||
    !challenge.desktopPublicKey ||
    challenge.protocol !== BRIDGE_CRYPTO_PROTOCOL
  ) {
    throw new Error("Desktop bridge did not provide a secure challenge.");
  }
  return challenge;
};

const readBridgeSessionResponse = (
  value: unknown,
): DesktopBridgeSessionResponse => {
  const record = asRecord(value);
  const session = {
    sessionId: asString(record?.sessionId).trim(),
    sessionSecret: asString(record?.sessionSecret).trim(),
    expiresAt:
      typeof record?.expiresAt === "number" ? record.expiresAt : Number.NaN,
    desktopPublicKey: asString(record?.desktopPublicKey).trim(),
    protocol: asString(record?.protocol).trim(),
  };
  if (
    !session.sessionId ||
    !session.sessionSecret ||
    !Number.isFinite(session.expiresAt) ||
    !session.desktopPublicKey ||
    session.protocol !== BRIDGE_CRYPTO_PROTOCOL
  ) {
    throw new Error("Desktop bridge session response was invalid.");
  }
  return session;
};

export const createDesktopBridgeSession = async (
  access: StoredPhoneAccess,
  baseUrl: string,
) => {
  const challenge = await readBridgeChallenge(baseUrl);
  if (challenge.desktopDeviceId !== access.desktopDeviceId) {
    throw new Error("Desktop bridge challenge was for a different computer.");
  }
  const keyPair = createBridgeKeyPair();
  const session = readBridgeSessionResponse(
    await postJson(
      "/api/mobile/desktop-bridge/session",
      {
        desktopDeviceId: access.desktopDeviceId,
        desktopChallenge: challenge.challenge,
        mobilePublicKey: keyPair.publicKey,
      },
      {
        headers: buildPhonePairProofHeaders(
          access,
          challenge.challenge,
          keyPair.publicKey,
        ),
      },
    ),
  );
  if (
    session.desktopPublicKey !== challenge.desktopPublicKey ||
    session.desktopPublicKey.trim().length === 0
  ) {
    throw new Error("Desktop bridge public key did not match Convex.");
  }
  return {
    session,
    headers: {
      "X-Stella-Bridge-Session-Id": session.sessionId,
      "X-Stella-Bridge-Session-Secret": session.sessionSecret,
      "X-Stella-Bridge-Challenge-Id": challenge.challengeId,
      "X-Stella-Bridge-Encrypted": BRIDGE_CRYPTO_PROTOCOL,
    },
    crypto: deriveBridgeCryptoSession({
      sessionId: session.sessionId,
      secretKey: keyPair.secretKey,
      peerPublicKey: session.desktopPublicKey,
      mobilePublicKey: keyPair.publicKey,
      desktopPublicKey: session.desktopPublicKey,
    }),
  };
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

const readDesktopDeveloperArtifactsEnabled = async (
  baseUrl: string,
  headers: Record<string, string>,
) => {
  try {
    const response = await fetch(`${baseUrl}/bridge/bootstrap`, { headers });
    if (!response.ok) return false;
    const parsed = asRecord(await response.json());
    const localStorage = asRecord(parsed?.localStorage);
    return asString(localStorage?.[DEVELOPER_RESOURCE_PREVIEWS_KEY]) === "true";
  } catch {
    return false;
  }
};

const filterDesktopBridgeArtifacts = (
  artifacts: ChatArtifact[],
  includeDeveloperArtifacts: boolean,
) =>
  includeDeveloperArtifacts
    ? artifacts
    : artifacts.filter((artifact) => artifact.payload.kind !== "source-diff");

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

  const bridgeSession = await createDesktopBridgeSession(access, baseUrl);
  return {
    baseUrl,
    headers: bridgeSession.headers,
    crypto: bridgeSession.crypto,
    includeDeveloperArtifacts: await readDesktopDeveloperArtifactsEnabled(
      baseUrl,
      bridgeSession.headers,
    ),
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
    const encryptedBody = encryptBridgePayload(bridge.crypto, "m2d", { args });
    const response = await fetch(
      `${bridge.baseUrl}/bridge/ipc/${encodeURIComponent(channel)}`,
      {
        method: "POST",
        headers: {
          ...bridge.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ envelope: encryptedBody }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(await readBridgeError(response));
    }
    const responseRecord = asRecord(await response.json());
    if (!isBridgeEncryptedEnvelope(responseRecord?.envelope)) {
      throw new Error("Desktop bridge returned an unencrypted response.");
    }
    const decoded = decryptBridgePayload(
      bridge.crypto,
      "d2m",
      responseRecord.envelope,
    ) as { result?: T };
    return decoded.result as T;
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
): Promise<DesktopBridgeMessage[]> {
  const rows = await invokeDesktopBridge<unknown[]>(
    bridge,
    "localChat:listSyncMessages",
    [
      {
        conversationId,
        maxMessages,
        includeDeveloperArtifacts: bridge.includeDeveloperArtifacts,
      },
    ],
  );
  return parseDesktopBridgeMessageRows(rows, conversationId);
}

function parseDesktopBridgeMessageRows(
  rows: unknown[],
  conversationId: string,
): DesktopBridgeMessage[] {
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(asRecord(row)))
    .map((row) => {
      const record = row as Record<string, unknown>;
      const id = asString(record.localMessageId).trim();
      const role = record.role;
      const text = normalizeDesktopChatMessageText(asString(record.text));
      const artifacts = parseChatArtifacts(record.artifacts, conversationId);
      const requestId = asString(record.requestId).trim();
      const timestamp =
        typeof record.timestamp === "number" &&
        Number.isFinite(record.timestamp)
          ? record.timestamp
          : undefined;
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
        ...(requestId ? { requestId } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
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
  const conversationChanged = Boolean(expected && expected !== conversationId);
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
          includeDeveloperArtifacts: bridge.includeDeveloperArtifacts,
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
  cryptoSession: BridgeCryptoSession,
  onEvent: (channel: string, data: unknown) => void,
  onClose?: () => void,
) {
  const pending = new Map<string, PendingResponse>();

  ws.onmessage = (event) => {
    let message: unknown = null;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const outerRecord = asRecord(message);
    const record = isBridgeEncryptedEnvelope(outerRecord?.envelope)
      ? asRecord(
          decryptBridgePayload(cryptoSession, "d2m", outerRecord.envelope),
        )
      : outerRecord;
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
    onClose?.();
  };

  const send = (payload: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("Desktop bridge disconnected.");
    }
    ws.send(
      JSON.stringify({
        envelope: encryptBridgePayload(cryptoSession, "m2d", payload),
      }),
    );
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
): Promise<DesktopBridgeMessage | null> {
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

async function readAssistantMessageForTurn(
  bridge: DesktopBridgeConnection,
  conversationId: string,
  userMessageId: string,
): Promise<DesktopBridgeMessage | null> {
  const expectedRequestId = userMessageId.trim();
  if (!expectedRequestId) return null;
  const messages = await listDesktopBridgeMessages(
    bridge,
    conversationId,
    DEFAULT_HISTORY_LIMIT,
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.requestId === expectedRequestId &&
      (message.text.trim() || (message.artifacts?.length ?? 0) > 0)
    ) {
      return message;
    }
  }
  return null;
}

const createClientRequestId = (conversationId: string) => {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `mobile:${conversationId}:${random}`;
};

type ConnectionOutcome =
  | { kind: "finished" }
  | { kind: "aborted" }
  | { kind: "timeout" }
  | { kind: "disconnected" }
  | { kind: "fatal"; error: unknown };

const isDisconnectError = (error: unknown) => {
  if (isNetworkFailure(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|timed out|could not connect|connect to your desktop/i.test(
    message,
  );
};

export async function sendDesktopBridgeChat({
  access,
  message,
  model,
  signal,
  onTextDelta,
  onArtifacts,
}: DesktopBridgeChatArgs): Promise<DesktopBridgeChatResult> {
  const text = message.trim();
  if (!text) {
    throw new Error("Message is required.");
  }
  if (signal?.aborted) {
    throw new BridgeAbortError();
  }

  let activeBridge = await resolveDesktopBridge(access);
  const conversationId = await getDesktopBridgeConversationId(activeBridge);
  // Stable idempotency key: the desktop dedupes retries of this exact send, so
  // reconnecting and re-issuing startChat can never spawn a duplicate run.
  const clientRequestId = createClientRequestId(conversationId);
  const startChatArgs = {
    conversationId,
    userPrompt: text,
    deviceId: access.mobileDeviceId,
    platform: "mobile",
    mode: "computer",
    storageMode: "local",
    clientRequestId,
    messageMetadata: {
      source: "stella_mobile",
      ...(model?.trim() ? { mobileModelPreference: model.trim() } : {}),
    },
  };

  // ── Run state shared across reconnect attempts ──────────────────────────
  let lastSeq = 0;
  let runId = "";
  let requestId = "";
  let submittedUserMessageId = "";
  let startIssued = false;
  let runStarted = false;
  let settled = false;
  let finalResult: DesktopBridgeChatResult | null = null;
  let finalError: unknown = null;

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

  const buildResult = (finalText: string): DesktopBridgeChatResult => ({
    text:
      finalText ||
      (artifactById.size > 0
        ? ""
        : "Stella finished, but did not return a message. Check the desktop app."),
    artifacts: [...artifactById.values()],
  });

  const finalizeSuccess = (result: DesktopBridgeChatResult) => {
    if (settled) return;
    settled = true;
    finalResult = result;
  };
  const finalizeError = (error: unknown) => {
    if (settled) return;
    settled = true;
    finalError = error;
  };

  const eventMatchesRun = (event: Record<string, unknown>) => {
    const eventConversationId = asString(event.conversationId);
    if (eventConversationId && eventConversationId !== conversationId) {
      return false;
    }
    const eventRequestId = asString(event.requestId);
    const eventRunId = asString(event.runId);
    if (requestId && eventRequestId && eventRequestId !== requestId) {
      return false;
    }
    if (runId && eventRunId && eventRunId !== runId) {
      return false;
    }
    return true;
  };

  const completeFromFinishedEvent = async (event: Record<string, unknown>) => {
    if (settled) return;
    const outcome = asString(event.outcome);
    const error = asString(event.error).trim() || asString(event.reason).trim();
    if (outcome === "canceled") {
      finalizeError(new BridgeAbortError());
      return;
    }
    if (error) {
      finalizeError(new Error(error));
      return;
    }
    let finalText = asString(event.finalText).trim();
    if (!finalText || artifactById.size === 0) {
      const latest = submittedUserMessageId
        ? await readAssistantMessageForTurn(
            activeBridge,
            conversationId,
            submittedUserMessageId,
          ).catch(() => null)
        : await readLatestAssistantMessage(activeBridge, conversationId).catch(
            () => null,
          );
      if (!finalText) {
        finalText = latest?.text.trim() ?? "";
      }
      mergeArtifacts(latest?.artifacts ?? []);
    }
    finalizeSuccess(buildResult(normalizeDesktopChatMessageText(finalText)));
  };

  // Process one agent event (live broadcast or replayed via agent:resume).
  // Resolves to true once the run reaches a terminal state. Seq-gating makes
  // replay idempotent against events we already saw live.
  const processAgentEvent = async (data: unknown): Promise<boolean> => {
    const event = asRecord(data);
    if (!event || !eventMatchesRun(event)) {
      return false;
    }
    const eventRequestId = asString(event.requestId);
    const eventRunId = asString(event.runId);
    const eventUserMessageId = asString(event.userMessageId);
    if (!requestId && eventRequestId) requestId = eventRequestId;
    if (!runId && eventRunId) runId = eventRunId;
    if (!submittedUserMessageId && eventUserMessageId) {
      submittedUserMessageId = eventUserMessageId;
    }
    if (eventRunId) runStarted = true;

    const seq = typeof event.seq === "number" ? event.seq : null;
    if (seq !== null) {
      if (seq <= lastSeq) return false;
      lastSeq = seq;
    }

    if (event.type === "stream") {
      const chunk = asString(event.chunk);
      if (chunk) onTextDelta?.(chunk);
      return false;
    }
    if (event.type === "run-finished") {
      await completeFromFinishedEvent(event);
      return true;
    }
    return false;
  };

  // Recover the final reply when the run completed while we were disconnected
  // and the desktop's event buffer no longer holds the terminal event.
  const recoverFinalFromDesktop = async (): Promise<boolean> => {
    if (settled) return true;
    if (!submittedUserMessageId) return false;
    const latest = await readAssistantMessageForTurn(
      activeBridge,
      conversationId,
      submittedUserMessageId,
    ).catch(() => null);
    if (!latest) return false;
    mergeArtifacts(latest?.artifacts ?? []);
    finalizeSuccess(
      buildResult(normalizeDesktopChatMessageText(latest?.text.trim() ?? "")),
    );
    return true;
  };

  const runConnection = async (
    isReconnect: boolean,
  ): Promise<ConnectionOutcome> => {
    let ws: WebSocket;
    try {
      ws = await openBridgeWebSocket(activeBridge, signal);
    } catch (error) {
      if (signal?.aborted) return { kind: "aborted" };
      return { kind: "disconnected" };
    }

    return await new Promise<ConnectionOutcome>((resolve) => {
      let outcomeSettled = false;
      let resuming = isReconnect;
      const pendingLive: unknown[] = [];
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let client: ReturnType<typeof createBridgeSocketClient>;

      const onAbort = () => finish({ kind: "aborted" });

      const finish = (outcome: ConnectionOutcome) => {
        if (outcomeSettled) return;
        outcomeSettled = true;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        signal?.removeEventListener("abort", onAbort);
        if (
          (outcome.kind === "aborted" || outcome.kind === "timeout") &&
          runId
        ) {
          try {
            void client.invoke("agent:cancelChat", [runId]).catch(() => {});
          } catch {
            // best-effort cancellation
          }
        }
        client.close();
        resolve(outcome);
      };

      const bumpInactivity = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(
          () => finish({ kind: "timeout" }),
          BRIDGE_RUN_TIMEOUT_MS,
        );
      };

      const handleLiveAgentEvent = (data: unknown) => {
        bumpInactivity();
        if (resuming) {
          pendingLive.push(data);
          return;
        }
        void processAgentEvent(data).then((finished) => {
          if (finished) finish({ kind: "finished" });
        });
      };

      client = createBridgeSocketClient(
        ws,
        activeBridge.crypto,
        (channel, data) => {
          if (channel === "display:update") {
            mergeArtifacts(
              filterDesktopBridgeArtifacts(
                parseChatArtifacts([data], conversationId),
                activeBridge.includeDeveloperArtifacts,
              ),
            );
            return;
          }
          if (channel === "agent:event") {
            handleLiveAgentEvent(data);
          }
        },
        () => finish({ kind: "disconnected" }),
      );

      client.subscribe("agent:event");
      client.subscribe("display:update");
      signal?.addEventListener("abort", onAbort);
      bumpInactivity();

      void (async () => {
        try {
          if (!runStarted) {
            const startResult = asRecord(
              await client.invoke(
                "agent:startChat",
                [startChatArgs],
                BRIDGE_INVOKE_TIMEOUT_MS,
              ),
            );
            const startedRequestId = asString(startResult?.requestId).trim();
            if (startedRequestId) {
              requestId = requestId || startedRequestId;
              startIssued = true;
            }
          }

          let activeRunId = "";
          if (isReconnect) {
            const resume = asRecord(
              await client.invoke(
                "agent:resume",
                [{ conversationId, lastSeq }],
                BRIDGE_SYNC_TIMEOUT_MS,
              ),
            );
            const activeRun = asRecord(resume?.activeRun);
            activeRunId = asString(activeRun?.runId).trim();
            if (activeRunId) {
              runId = runId || activeRunId;
              runStarted = true;
              const activeUserMessageId = asString(
                activeRun?.userMessageId,
              ).trim();
              if (!submittedUserMessageId && activeUserMessageId) {
                submittedUserMessageId = activeUserMessageId;
              }
            }
            const replayEvents = Array.isArray(resume?.events)
              ? resume.events
              : [];
            for (const replayEvent of replayEvents) {
              if (await processAgentEvent(replayEvent)) {
                finish({ kind: "finished" });
                return;
              }
            }
          }

          // Drain anything that arrived live while we were priming, in order,
          // before switching to direct live handling. Done inside the resuming
          // guard so no event can slip past unprocessed.
          while (pendingLive.length > 0) {
            const next = pendingLive.shift();
            if (await processAgentEvent(next)) {
              finish({ kind: "finished" });
              return;
            }
          }
          resuming = false;

          // On reconnect, if the desktop reports no active run and never
          // replayed a terminal event, the run finished while we were away.
          if (
            isReconnect &&
            !settled &&
            (runStarted || startIssued) &&
            !activeRunId
          ) {
            if (await recoverFinalFromDesktop()) {
              finish({ kind: "finished" });
              return;
            }
          }
        } catch (error) {
          if (signal?.aborted) {
            finish({ kind: "aborted" });
            return;
          }
          if (isDisconnectError(error)) {
            finish({ kind: "disconnected" });
            return;
          }
          finalizeError(error);
          finish({ kind: "fatal", error });
        }
      })();
    });
  };

  let attempt = 0;
  let isReconnect = false;
  while (!settled) {
    const outcome = await runConnection(isReconnect);
    if (settled || outcome.kind === "finished") {
      break;
    }
    if (outcome.kind === "aborted") {
      throw new BridgeAbortError();
    }
    if (outcome.kind === "fatal") {
      throw finalError ?? outcome.error;
    }
    if (outcome.kind === "timeout") {
      throw new Error("Stella did not reply in time. Try again in a moment.");
    }
    // disconnected → try to re-attach to the still-running desktop run.
    if (attempt >= BRIDGE_RECONNECT_MAX_ATTEMPTS) {
      await recoverFinalFromDesktop().catch(() => false);
      if (settled) break;
      throw new Error(
        "Lost the connection to your desktop. Keep Stella open and try again.",
      );
    }
    attempt += 1;
    isReconnect = true;
    const delay = Math.min(
      BRIDGE_RECONNECT_MAX_DELAY_MS,
      BRIDGE_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    );
    await sleep(delay);
    if (signal?.aborted) {
      throw new BridgeAbortError();
    }
    // Re-resolve in case the desktop rotated its tunnel URL or token while we
    // were away; fall back to the last good bridge if discovery hiccups.
    activeBridge = await resolveDesktopBridge(access).catch(() => activeBridge);
  }

  if (finalError) {
    throw finalError;
  }
  if (!finalResult) {
    throw new Error("Stella did not return a response.");
  }
  return finalResult;
}
