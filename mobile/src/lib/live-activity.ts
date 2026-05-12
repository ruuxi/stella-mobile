import { Platform } from "react-native";
import type { LiveActivity } from "expo-widgets";
import type { ComputerActivityProps } from "../../widgets/ComputerActivity";

type ActivityFactory = {
  start: (
    props: ComputerActivityProps,
    url?: string,
  ) => LiveActivity<ComputerActivityProps>;
};

let cachedFactory: ActivityFactory | null = null;
let factoryFailed = false;

const TRIM_PREVIEW = 140;

const loadFactory = (): ActivityFactory | null => {
  if (cachedFactory) return cachedFactory;
  if (factoryFailed) return null;
  // expo-widgets is iOS-only and the native module is unavailable in
  // Expo Go; both cases must degrade gracefully.
  if (Platform.OS !== "ios") {
    factoryFailed = true;
    return null;
  }
  try {
    // Require lazily so importing this module in a context without the
    // native binding (e.g. tests) doesn't crash at module-load time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../widgets/ComputerActivity") as {
      default: ActivityFactory;
    };
    cachedFactory = mod.default;
    return cachedFactory;
  } catch {
    factoryFailed = true;
    return null;
  }
};

const trimPreview = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TRIM_PREVIEW);

/**
 * Begin a "Stella is working on your computer" Live Activity. Returns
 * an opaque handle whose `update` / `finish` methods do nothing if
 * Live Activities aren't available on this build/device.
 */
export function startComputerLiveActivity(): {
  update: (preview: string) => void;
  finish: (props: { ok: boolean; preview?: string }) => void;
} {
  const factory = loadFactory();
  if (!factory) {
    return { update: () => {}, finish: () => {} };
  }

  let instance: LiveActivity<ComputerActivityProps> | null = null;
  const startedAtMs = Date.now();
  try {
    instance = factory.start({
      state: "working",
      startedAtMs,
    });
  } catch {
    instance = null;
  }

  return {
    update: (preview: string) => {
      if (!instance) return;
      const trimmed = trimPreview(preview);
      void instance
        .update({
          state: "working",
          startedAtMs,
          ...(trimmed ? { preview: trimmed } : {}),
        })
        .catch(() => {
          // best-effort
        });
    },
    finish: ({ ok, preview }) => {
      if (!instance) return;
      const trimmed = preview ? trimPreview(preview) : undefined;
      void instance
        .end(
          "default",
          {
            state: ok ? "done" : "error",
            startedAtMs,
            ...(trimmed ? { preview: trimmed } : {}),
          },
          new Date(),
        )
        .catch(() => {
          // best-effort
        });
    },
  };
}
