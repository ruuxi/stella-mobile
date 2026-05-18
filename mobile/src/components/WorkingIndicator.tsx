import { memo, useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { StellaAnimation } from "./stella-animation";

const CREATURE_WIDTH = 84;
const CREATURE_HEIGHT = 48;

/** Fixed slot height — always reserved above the composer (padding + creature). */
export const WORKING_INDICATOR_SLOT_HEIGHT =
  6 + CREATURE_HEIGHT + 4;

interface WorkingIndicatorProps {
  /** When true, the indicator fades in and animates. When false, it fades out. */
  active: boolean;
}

/**
 * Small Stella creature shown above the composer while the assistant is
 * working. The slot height is always reserved so the composer and message
 * list never jump when the indicator appears or disappears.
 */
export const WorkingIndicator = memo(function WorkingIndicator({
  active,
}: WorkingIndicatorProps) {
  const opacity = useRef(new Animated.Value(active ? 1 : 0)).current;
  const shownRef = useRef(active);

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: active ? 1 : 0,
      duration: active ? 220 : 320,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) shownRef.current = active;
    });
  }, [active, opacity]);

  const mountGl = active || shownRef.current;

  return (
    <View style={styles.slot}>
      <Animated.View style={[styles.row, { opacity }]} pointerEvents="none">
        {mountGl ? (
          <View style={styles.creature}>
            <StellaAnimation
              width={CREATURE_WIDTH}
              height={CREATURE_HEIGHT}
              paused={!active}
            />
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: {
    height: WORKING_INDICATOR_SLOT_HEIGHT,
    flexShrink: 0,
    overflow: "hidden",
  },
  row: {
    height: WORKING_INDICATOR_SLOT_HEIGHT,
    paddingHorizontal: 24,
    paddingTop: 6,
    paddingBottom: 4,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  creature: {
    width: CREATURE_WIDTH,
    height: CREATURE_HEIGHT,
  },
});
