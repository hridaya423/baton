import type { ColorValue } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** The mark's three blocks in its 24-unit box, before the 45 degree turn: cap, bar, cap. */
export const BATON_BLOCK_PATHS = [
  "M2.6 9H5.8V15H2.6C1.937 15 1.4 14.463 1.4 13.8V10.2C1.4 9.537 1.937 9 2.6 9Z",
  "M7 9H17V15H7V9Z",
  "M18.2 9H21.4C22.063 9 22.6 9.537 22.6 10.2V13.8C22.6 14.463 22.063 15 21.4 15H18.2V9Z",
] as const;

export const BATON_MARK_ROTATION = "rotate(-45 12 12)";

/** Baton's mark: a bar with a cap at each end, set at 45 degrees. Same drawing as the web mark. */
export function BatonMark(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg accessibilityLabel="Baton" height={props.size} width={props.size} viewBox="0 0 24 24">
      <G transform={BATON_MARK_ROTATION}>
        <ThemedPath
          d={BATON_BLOCK_PATHS.join("")}
          color={props.color}
          colorClassName={props.colorClassName}
          fill="currentColor"
        />
      </G>
    </Svg>
  );
}
