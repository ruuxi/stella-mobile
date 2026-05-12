import { useMemo } from "react";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import {
  GlassView,
  isLiquidGlassAvailable,
  type GlassStyle,
} from "expo-glass-effect";
import { useColors, useTheme } from "../theme/theme-context";

type GlassCardProps = ViewProps & {
  /** Glass intensity; default "regular" matches Apple sidebar/surface chrome. */
  intensity?: GlassStyle;
  /** Apply a subtle border ring for definition (off by default). */
  ringed?: boolean;
  /** Border radius for both the glass surface and the fallback. */
  radius?: number;
};

const liquidGlassSupported = (() => {
  try {
    return Platform.OS === "ios" && isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

/**
 * Surface that renders Apple's Liquid Glass on iOS 26+ and a softly-tinted
 * fallback card everywhere else. Behaves like a regular `<View>` —
 * children render directly inside the glass surface and the fallback
 * keeps the same border-radius / overflow shape.
 */
export function GlassCard({
  intensity = "regular",
  ringed = false,
  radius = 16,
  style,
  children,
  ...rest
}: GlassCardProps) {
  const colors = useColors();
  const { isDark } = useTheme();
  const fallbackStyle = useMemo(
    () => ({
      backgroundColor: isDark
        ? "rgba(255,255,255,0.06)"
        : "rgba(255,255,255,0.72)",
      borderColor: ringed ? colors.border : "transparent",
      borderRadius: radius,
      borderWidth: ringed ? StyleSheet.hairlineWidth : 0,
      overflow: "hidden" as const,
    }),
    [colors.border, isDark, radius, ringed],
  );

  if (liquidGlassSupported) {
    return (
      <GlassView
        glassEffectStyle={intensity}
        style={[
          { borderRadius: radius, overflow: "hidden" },
          ringed && {
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
          },
          style,
        ]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[fallbackStyle, style]} {...rest}>
      {children}
    </View>
  );
}
