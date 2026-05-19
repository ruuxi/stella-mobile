import { memo } from "react";
import { StyleSheet, View } from "react-native";
import {
  StellaAnimation,
  WORKING_INDICATOR_DISPLAY_PT,
  WORKING_INDICATOR_GRID,
  getWorkingIndicatorLayout,
} from "./stella-animation";

const indicatorLayout = getWorkingIndicatorLayout();

/** Fixed slot height — reserved above the composer (padding + circular viewport). */
export const WORKING_INDICATOR_SLOT_HEIGHT =
  6 + indicatorLayout.viewport + 4;

interface WorkingIndicatorProps {
  /** When true, the indicator is visible and the creature animates. */
  active: boolean;
}

/**
 * Stella above the composer.
 *
 * The GLView stays mounted forever, opacity is a plain static style (not
 * `Animated.Value`): on iOS, wrapping a GLView in an `Animated.View` with
 * opacity makes UIKit snapshot the GL surface into an offscreen buffer and
 * reuse it, freezing the creature. Static opacity is just a CALayer property
 * that composes normally over the live GL surface.
 */
export const WorkingIndicator = memo(function WorkingIndicator({
  active,
}: WorkingIndicatorProps) {
  const { viewport, display } = indicatorLayout;

  return (
    <View style={[styles.slot, { opacity: active ? 1 : 0 }]} pointerEvents="none">
      <View style={styles.row} collapsable={false}>
        <View
          style={[styles.viewport, { width: viewport, height: viewport }]}
          collapsable={false}
        >
          <View
            style={[styles.canvasSlot, { width: display, height: display }]}
            collapsable={false}
          >
            <StellaAnimation
              width={WORKING_INDICATOR_GRID}
              height={WORKING_INDICATOR_GRID}
              displayWidth={WORKING_INDICATOR_DISPLAY_PT}
              displayHeight={WORKING_INDICATOR_DISPLAY_PT}
              frameSkip={1}
              paused={!active}
            />
          </View>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: {
    height: WORKING_INDICATOR_SLOT_HEIGHT,
    flexShrink: 0,
  },
  row: {
    height: WORKING_INDICATOR_SLOT_HEIGHT,
    paddingHorizontal: 24,
    paddingTop: 6,
    paddingBottom: 4,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  viewport: {
    borderRadius: 999,
    overflow: "hidden",
    position: "relative",
  },
  canvasSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
});
