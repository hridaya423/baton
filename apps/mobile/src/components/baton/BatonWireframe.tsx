import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

// The mark's blocks along one axis (cap, bar, cap), as slabs 6 deep and 4 tall.
const BLOCK_SPANS = [
  [1.4, 5.8],
  [7, 17],
  [18.2, 22.6],
] as const;
const DEPTH = 6;
const HEIGHT = 4;
const COS30 = Math.cos(Math.PI / 6);

function project(x: number, y: number, z: number): readonly [number, number] {
  return [(x - y) * COS30, (x + y) * 0.5 - z];
}

function boxEdges(x0: number, x1: number): string {
  const corners = [x0, x1].flatMap((x) =>
    [0, DEPTH].flatMap((y) => [0, HEIGHT].map((z) => project(x, y, z))),
  );
  // Corner index bits: x (4), y (2), z (1). An edge joins corners one bit apart.
  const edges: string[] = [];
  for (let a = 0; a < 8; a++) {
    for (const bit of [1, 2, 4]) {
      const b = a | bit;
      if (b === a) continue;
      const [ax, ay] = corners[a]!;
      const [bx, by] = corners[b]!;
      edges.push(`M${ax.toFixed(2)} ${ay.toFixed(2)}L${bx.toFixed(2)} ${by.toFixed(2)}`);
    }
  }
  return edges.join("");
}

const WIREFRAME_PATH = BLOCK_SPANS.map(([x0, x1]) => boxEdges(x0, x1)).join("");
const POINTS = BLOCK_SPANS.flatMap(([x0, x1]) =>
  [x0, x1].flatMap((x) => [0, DEPTH].flatMap((y) => [0, HEIGHT].map((z) => project(x, y, z)))),
);
const MIN_X = Math.min(...POINTS.map(([x]) => x));
const MIN_Y = Math.min(...POINTS.map(([, y]) => y));
const WIDTH = Math.max(...POINTS.map(([x]) => x)) - MIN_X;
const TALL = Math.max(...POINTS.map(([, y]) => y)) - MIN_Y;
const PAD = 1;
const VIEW_BOX = `${(MIN_X - PAD).toFixed(2)} ${(MIN_Y - PAD).toFixed(2)} ${(WIDTH + PAD * 2).toFixed(2)} ${(TALL + PAD * 2).toFixed(2)}`;

/** The mark's three blocks as a planned, unbuilt hairline wireframe. Static. */
export function BatonWireframe(props: {
  readonly width: number;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      width={props.width}
      height={(props.width * (TALL + PAD * 2)) / (WIDTH + PAD * 2)}
      viewBox={VIEW_BOX}
    >
      <ThemedPath
        d={WIREFRAME_PATH}
        colorClassName={props.colorClassName ?? "accent-foreground-muted"}
        stroke="currentColor"
        strokeWidth={0.18}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}
