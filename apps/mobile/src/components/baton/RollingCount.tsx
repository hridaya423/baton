import { View } from "react-native";
import Animated, { FadeInDown, FadeOutUp, ReduceMotion } from "react-native-reanimated";

import { AppText as Text } from "../ui/AppText";
import { MOBILE_TEXT_CLASSES } from "../../lib/typography";
import { cn } from "../../lib/cn";

const ROLL_IN = FadeInDown.duration(220).reduceMotion(ReduceMotion.System);
const ROLL_OUT = FadeOutUp.duration(160).reduceMotion(ReduceMotion.System);

/** A tabular count whose old value rolls up and out as the new one rolls in. */
export function RollingCount(props: {
  readonly value: number;
  readonly textRole: keyof typeof MOBILE_TEXT_CLASSES;
  readonly className?: string;
}) {
  return (
    <View className="overflow-hidden">
      <Animated.View key={props.value} entering={ROLL_IN} exiting={ROLL_OUT}>
        <Text textRole={props.textRole} className={cn("tabular-nums", props.className)}>
          {props.value}
        </Text>
      </Animated.View>
    </View>
  );
}
