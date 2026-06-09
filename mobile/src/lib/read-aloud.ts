import { useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { env } from "../config/env";
import { assert } from "./assert";
import { getConvexToken } from "./auth-token";

const READ_ALOUD_KEY = "stella-mobile.read-aloud-enabled";
const TTS_PATH = "/api/voice/tts";

let cachedReadAloudEnabled = false;
const listeners = new Set<() => void>();
let currentPlayer: AudioPlayer | null = null;
let currentFile: File | null = null;
let playbackGeneration = 0;

const emit = () => {
  for (const listener of listeners) listener();
};

export const readAloudStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot() {
    return cachedReadAloudEnabled;
  },
};

export async function loadReadAloudPreference() {
  const raw = await AsyncStorage.getItem(READ_ALOUD_KEY);
  cachedReadAloudEnabled = raw === "1";
  emit();
  return cachedReadAloudEnabled;
}

export async function setReadAloudEnabled(enabled: boolean) {
  cachedReadAloudEnabled = enabled;
  emit();
  if (enabled) {
    await AsyncStorage.setItem(READ_ALOUD_KEY, "1");
  } else {
    await AsyncStorage.removeItem(READ_ALOUD_KEY);
    stopReadAloud();
  }
}

const stripForSpeech = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_>~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const readErrorMessage = async (response: Response) => {
  const text = await response.text().catch(() => "");
  if (!text) return "Could not read that reply aloud.";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = parsed.error ?? parsed.message;
    return typeof message === "string" && message.trim()
      ? message.trim()
      : "Could not read that reply aloud.";
  } catch {
    return text.trim() || "Could not read that reply aloud.";
  }
};

const createAudioFile = (audio: ArrayBuffer, contentType: string) => {
  const ext = contentType.includes("mpeg") || contentType.includes("mp3")
    ? "mp3"
    : "wav";
  const file = new File(
    Paths.cache,
    `stella-read-aloud-${Date.now()}-${playbackGeneration}.${ext}`,
  );
  file.create({ overwrite: true, intermediates: true });
  file.write(new Uint8Array(audio));
  return file;
};

async function fetchInworldReadAloudAudio(text: string) {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();
  const response = await fetch(`${env.convexSiteUrl}${TTS_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voiceProvider: "inworld",
      voice: "Evelyn",
      model: "inworld-tts-2",
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return {
    audio: await response.arrayBuffer(),
    contentType:
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/wav",
  };
}

export function stopReadAloud() {
  playbackGeneration += 1;
  const player = currentPlayer;
  currentPlayer = null;
  if (player) {
    try {
      player.pause();
      player.remove();
      player.release();
    } catch {
      /* ignore */
    }
  }

  const file = currentFile;
  currentFile = null;
  if (file) {
    try {
      file.delete();
    } catch {
      /* ignore */
    }
  }
}

export async function speakReply(text: string) {
  const spoken = stripForSpeech(text);
  if (!spoken) return;

  stopReadAloud();
  const generation = playbackGeneration;

  try {
    const { audio, contentType } = await fetchInworldReadAloudAudio(spoken);
    if (generation !== playbackGeneration) return;

    const file = createAudioFile(audio, contentType);
    if (generation !== playbackGeneration) {
      try {
        file.delete();
      } catch {
        /* ignore */
      }
      return;
    }

    await setAudioModeAsync({ playsInSilentMode: true });
    const player = createAudioPlayer({ uri: file.uri });
    currentFile = file;
    currentPlayer = player;
    player.play();
  } catch (error) {
    console.warn("[read-aloud] playback failed", error);
  }
}

export function useReadAloudPreference() {
  const [enabled, setEnabled] = useState(readAloudStore.getSnapshot);

  useEffect(() => {
    void loadReadAloudPreference();
    return readAloudStore.subscribe(() => {
      setEnabled(readAloudStore.getSnapshot());
    });
  }, []);

  return useMemo(
    () => ({
      enabled,
      setEnabled: setReadAloudEnabled,
    }),
    [enabled],
  );
}
