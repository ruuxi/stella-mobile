import { Platform, View, type ViewStyle, type StyleProp } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import Feather from "@expo/vector-icons/Feather";

/**
 * Cross-platform icon wrapper that renders SF Symbols on iOS and falls
 * back to Feather on Android / web. Every call site passes a single
 * `name` from `IconName` which we translate to both libraries.
 */
export type IconName =
  | "menu"
  | "plus"
  | "x"
  | "chevron-down"
  | "arrow-up"
  | "arrow-up-right"
  | "mic"
  | "mic-off"
  | "check"
  | "message-square"
  | "monitor"
  | "user";

const FEATHER_NAMES: Record<IconName, React.ComponentProps<typeof Feather>["name"]> = {
  "menu": "menu",
  "plus": "plus",
  "x": "x",
  "chevron-down": "chevron-down",
  "arrow-up": "arrow-up",
  "arrow-up-right": "arrow-up-right",
  "mic": "mic",
  "mic-off": "mic-off",
  "check": "check",
  "message-square": "message-square",
  "monitor": "monitor",
  "user": "user",
};

const SYMBOL_NAMES: Record<IconName, SymbolViewProps["name"]> = {
  "menu": "line.3.horizontal",
  "plus": "plus",
  "x": "xmark",
  "chevron-down": "chevron.down",
  "arrow-up": "arrow.up",
  "arrow-up-right": "arrow.up.right",
  "mic": "mic",
  "mic-off": "mic.slash",
  "check": "checkmark",
  "message-square": "message",
  "monitor": "desktopcomputer",
  "user": "person.crop.circle",
};

type IconProps = {
  name: IconName;
  size: number;
  color: string;
  /** Pass "monochrome" (default), "hierarchical", or "multicolor" for SF Symbols. */
  tintMode?: "monochrome" | "hierarchical" | "multicolor";
  /** Symbol effect for SF Symbols (e.g. "bounce", "pulse"). iOS 17+. */
  effect?: "bounce" | "pulse";
  /** Use the filled variant on iOS when available (we tack on `.fill`). */
  filled?: boolean;
  weight?: SymbolViewProps["weight"];
  style?: StyleProp<ViewStyle>;
};

export function Icon({
  name,
  size,
  color,
  tintMode = "monochrome",
  effect,
  filled,
  weight = "medium",
  style,
}: IconProps) {
  if (Platform.OS === "ios") {
    const base = SYMBOL_NAMES[name];
    // SF Symbol filled variants follow the `<name>.fill` convention; we only
    // tack it on for symbols that genuinely have a filled glyph.
    const filledName =
      filled &&
      (name === "mic" || name === "x" || name === "user" || name === "message-square")
        ? (`${base}.fill` as SymbolViewProps["name"])
        : base;
    return (
      <View style={[{ width: size, height: size, alignItems: "center", justifyContent: "center" }, style]}>
        <SymbolView
          name={filledName}
          size={size}
          tintColor={color}
          type={tintMode === "hierarchical" ? "hierarchical" : tintMode === "multicolor" ? "multicolor" : "monochrome"}
          weight={weight}
          {...(effect ? { animationSpec: { effect: { type: effect } } } : {})}
        />
      </View>
    );
  }
  return <Feather name={FEATHER_NAMES[name]} size={size} color={color} style={style} />;
}
