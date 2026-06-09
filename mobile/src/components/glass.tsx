import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import {
  GlassView,
  isLiquidGlassAvailable,
  type GlassStyle,
} from "expo-glass-effect";
import { useColors, useTheme } from "../theme/theme-context";
import { fadeHex, hexToOklch } from "../theme/oklch";
import { tapLight } from "../lib/haptics";

/**
 * Whether Apple's Liquid Glass (iOS 26+ `UIGlassEffect`) is actually available.
 * Computed once at module load: the native API is iOS-only, and on older iOS
 * versions / Android `isLiquidGlassAvailable()` reports false so every glass
 * surface below falls back to a softly-tinted view.
 */
export const liquidGlassSupported: boolean = (() => {
  try {
    return Platform.OS === "ios" && isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

/**
 * Resolve the glass `colorScheme` from the *Stella* theme rather than the OS.
 * The app owns its own light/dark + forced-mode (Pearl/Noir) palette, so the
 * glass tint must follow that, not the device appearance.
 */
function useGlassScheme(): "light" | "dark" {
  const { isDark } = useTheme();
  return isDark ? "dark" : "light";
}

type GlassSurfaceProps = ViewProps & {
  /** Liquid Glass intensity. `regular` for chrome/cards, `clear` for controls. */
  glass?: GlassStyle;
  /** Translucent tint layered over the glass (and the fallback). */
  tintColor?: string;
  /** Whether the glass reacts to touches with the native interactive sheen. */
  interactive?: boolean;
  /** Corner radius applied to both the glass surface and the fallback. */
  radius?: number;
  /** Hairline ring for extra definition against busy backdrops. */
  ringed?: boolean;
  /**
   * Solid-ish background used when Liquid Glass is unavailable. Defaults to a
   * theme-aware translucent tint that mimics frosted chrome. Pass an opaque
   * color (e.g. `colors.surface`) for surfaces that sit over busy content and
   * need to stay legible (menus, the composer).
   */
  fallbackColor?: string;
};

/**
 * Surface that renders Apple's Liquid Glass on iOS 26+ and a softly-tinted
 * fallback everywhere else. Behaves like a regular `<View>`: children render
 * directly inside, and the fallback keeps the same radius / clipping shape.
 */
export function GlassSurface({
  glass = "regular",
  tintColor,
  interactive = false,
  radius = 16,
  ringed = false,
  fallbackColor,
  style,
  children,
  ...rest
}: GlassSurfaceProps) {
  const colors = useColors();
  const { isDark } = useTheme();
  const scheme = useGlassScheme();

  const ring = ringed
    ? { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }
    : null;

  if (liquidGlassSupported) {
    return (
      <GlassView
        glassEffectStyle={glass}
        isInteractive={interactive}
        colorScheme={scheme}
        tintColor={tintColor}
        style={[{ borderRadius: radius, overflow: "hidden" }, ring, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  const fallback: ViewStyle = {
    backgroundColor:
      fallbackColor ??
      (isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.72)"),
    borderRadius: radius,
    overflow: "hidden",
  };

  return (
    <View style={[fallback, ring, style]} {...rest}>
      {tintColor ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]}
        />
      ) : null}
      {children}
    </View>
  );
}

type GlassCardProps = ViewProps & {
  intensity?: GlassStyle;
  ringed?: boolean;
  radius?: number;
};

/**
 * Back-compatible card wrapper (sidebar, pairing input, etc.). Thin alias over
 * {@link GlassSurface} so existing call sites keep working unchanged.
 */
export function GlassCard({
  intensity = "regular",
  ringed = false,
  radius = 16,
  ...rest
}: GlassCardProps) {
  return (
    <GlassSurface glass={intensity} ringed={ringed} radius={radius} {...rest} />
  );
}

type GlassButtonProps = Omit<PressableProps, "style" | "children"> & {
  /** Diameter for a circular button; omit and pass `style` for custom shapes. */
  size?: number;
  radius?: number;
  glass?: GlassStyle;
  tintColor?: string;
  ringed?: boolean;
  fallbackColor?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/**
 * Standalone Liquid Glass icon button for controls that float *over* content
 * (scroll-to-bottom, the computer options button, …). Interactive glass on
 * iOS 26+, tinted-circle fallback elsewhere.
 *
 * Do not nest inside another glass surface — Apple's HIG advises against glass
 * on glass, so composer-internal controls stay flat.
 */
export function GlassButton({
  size = 40,
  radius,
  glass = "clear",
  tintColor,
  ringed = true,
  fallbackColor,
  style,
  children,
  ...rest
}: GlassButtonProps) {
  const cornerRadius = radius ?? size / 2;
  return (
    <Pressable
      style={({ pressed }) => [
        { width: size, height: size },
        pressed && styles.pressed,
        style,
      ]}
      {...rest}
    >
      <GlassSurface
        glass={glass}
        interactive
        tintColor={tintColor}
        ringed={ringed}
        radius={cornerRadius}
        fallbackColor={fallbackColor}
        style={styles.buttonGlass}
      >
        {children}
      </GlassSurface>
    </Pressable>
  );
}

const TOGGLE_WIDTH = 52;
const TOGGLE_HEIGHT = 32;
const TOGGLE_THUMB = 26;
const TOGGLE_PAD = (TOGGLE_HEIGHT - TOGGLE_THUMB) / 2;
const TOGGLE_TRAVEL = TOGGLE_WIDTH - TOGGLE_THUMB - TOGGLE_PAD * 2;

type GlassToggleProps = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
};

/**
 * Liquid Glass switch. The track is a glass pill that tints toward the accent
 * when on; the thumb slides with a spring. Falls back to a tinted track + thumb
 * when Liquid Glass is unavailable, and adapts the thumb color per theme so it
 * stays legible across light, dark, and the forced Pearl/Noir palettes.
 */
export function GlassToggle({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
}: GlassToggleProps) {
  const colors = useColors();
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: value ? 1 : 0,
      damping: 18,
      stiffness: 240,
      mass: 0.7,
      useNativeDriver: true,
    }).start();
  }, [anim, value]);

  const thumbColor = value ? colors.accentForeground : "#ffffff";
  // Accent-light themes (e.g. Noir's near-white accent) need a darker neutral
  // off-track so the white thumb still reads; otherwise a faint text tint.
  const accentIsLight = hexToOklch(colors.accent).l > 0.7;
  const offTrack = accentIsLight
    ? fadeHex(colors.text, 0.18)
    : fadeHex(colors.text, 0.14);

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [TOGGLE_PAD, TOGGLE_PAD + TOGGLE_TRAVEL],
  });

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        tapLight();
        onValueChange(!value);
      }}
      style={[styles.toggleTrack, disabled && styles.toggleDisabled]}
    >
      <GlassSurface
        glass="clear"
        radius={TOGGLE_HEIGHT / 2}
        fallbackColor={offTrack}
        style={StyleSheet.absoluteFill}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.accent, opacity: anim },
          ]}
        />
      </GlassSurface>
      <Animated.View
        style={[
          styles.toggleThumb,
          { backgroundColor: thumbColor, transform: [{ translateX }] },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
  buttonGlass: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    width: "100%",
  },
  toggleTrack: {
    borderRadius: TOGGLE_HEIGHT / 2,
    height: TOGGLE_HEIGHT,
    justifyContent: "center",
    width: TOGGLE_WIDTH,
  },
  toggleDisabled: { opacity: 0.5 },
  toggleThumb: {
    borderColor: "rgba(0,0,0,0.06)",
    borderRadius: TOGGLE_THUMB / 2,
    borderWidth: StyleSheet.hairlineWidth,
    height: TOGGLE_THUMB,
    left: 0,
    position: "absolute",
    top: TOGGLE_PAD,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 2,
    elevation: 2,
    width: TOGGLE_THUMB,
  },
});
