import { AppText as Text } from "../ui/AppText";
import { cn } from "../../lib/cn";

/** A mono micro caption for kind, model, machine and time. Use sparingly. */
export function HudLabel(props: {
  readonly children: string;
  readonly className?: string;
  readonly numberOfLines?: number;
}) {
  return (
    <Text
      textRole="micro"
      numberOfLines={props.numberOfLines}
      className={cn("font-mono text-foreground-muted", props.className)}
    >
      {props.children}
    </Text>
  );
}
