import { HStack, Image, Text, VStack } from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "expo-symbols";
import { createLiveActivity } from "expo-widgets";
import type { LiveActivityEnvironment } from "expo-widgets/build/Widgets.types";

/**
 * Props the Live Activity reads to render itself. Kept tiny so the JS
 * runtime that powers SwiftUI rendering can serialize them cheaply.
 *
 * `state` drives both the headline copy and the symbol; `preview` is
 * optional and only filled in once the reply lands.
 */
export type ComputerActivityProps = {
  state: "working" | "done" | "error";
  startedAtMs: number;
  preview?: string;
};

const ACCENT_LIGHT = "#0A66FF";
const ACCENT_DARK = "#7AB8FF";

const headlineFor = (state: ComputerActivityProps["state"]): string => {
  switch (state) {
    case "working":
      return "Stella is on your computer";
    case "done":
      return "Stella finished";
    case "error":
      return "Could not reach your computer";
  }
};

const symbolFor = (state: ComputerActivityProps["state"]): SFSymbol => {
  switch (state) {
    case "working":
      return "sparkles";
    case "done":
      return "checkmark.circle.fill";
    case "error":
      return "exclamationmark.triangle.fill";
  }
};

const subtitleFor = (props: ComputerActivityProps): string => {
  if (props.state === "done" && props.preview) {
    return props.preview;
  }
  if (props.state === "working") {
    return "Working on it\u2026";
  }
  if (props.state === "error") {
    return "Tap to open Stella and try again.";
  }
  return "";
};

const ComputerActivity = (
  props: ComputerActivityProps,
  environment: LiveActivityEnvironment,
) => {
  "widget";
  const accent =
    environment.colorScheme === "dark" ? ACCENT_DARK : ACCENT_LIGHT;
  const headline = headlineFor(props.state);
  const subtitle = subtitleFor(props);
  const symbol = symbolFor(props.state);

  return {
    banner: (
      <VStack modifiers={[padding({ all: 14 })]}>
        <HStack>
          <Image systemName={symbol} color={accent} />
          <Text
            modifiers={[font({ weight: "semibold", size: 15 }), foregroundStyle(accent)]}
          >
            {headline}
          </Text>
        </HStack>
        {subtitle ? (
          <Text modifiers={[font({ size: 14 }), padding({ top: 4 })]}>
            {subtitle}
          </Text>
        ) : (
          <Text>{""}</Text>
        )}
      </VStack>
    ),
    compactLeading: <Image systemName={symbol} color={accent} />,
    compactTrailing: (
      <Text modifiers={[font({ weight: "medium", size: 13 })]}>
        {props.state === "working" ? "Working" : props.state === "done" ? "Done" : "Error"}
      </Text>
    ),
    minimal: <Image systemName={symbol} color={accent} />,
    expandedLeading: (
      <VStack modifiers={[padding({ leading: 12, top: 8, bottom: 8 })]}>
        <Image systemName={symbol} color={accent} />
        <Text modifiers={[font({ size: 12 })]}>Stella</Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ trailing: 12, top: 8, bottom: 8 })]}>
        <Text modifiers={[font({ weight: "semibold", size: 13 }), foregroundStyle(accent)]}>
          {props.state === "working" ? "On computer" : props.state === "done" ? "Finished" : "Error"}
        </Text>
      </VStack>
    ),
    expandedBottom: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <Text modifiers={[font({ weight: "semibold", size: 14 })]}>{headline}</Text>
        {subtitle ? (
          <Text modifiers={[font({ size: 13 }), padding({ top: 2 })]}>
            {subtitle}
          </Text>
        ) : (
          <Text>{""}</Text>
        )}
      </VStack>
    ),
  };
};

export default createLiveActivity<ComputerActivityProps>(
  "ComputerActivity",
  ComputerActivity,
);
