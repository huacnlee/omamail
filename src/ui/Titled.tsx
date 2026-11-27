// A panel with its title set on the top edge of its 1pt border, over a
// background knockout (NsVim's `Titled`; docs/DESIGN.md, Visual language
// v2): grouped content that floats in a pane, in place of a filled card. The
// frame is an absolute child over the content, and the title over the frame,
// so neither the content nor a child's own border breaks the line. The title
// is plain text, at caption size in muted text, 12pt in from the left.
import { context, Text, View, type AccessibilityRole, type JSX } from "nsh";
import { scaled } from "./font";
import { cx, RADIUS, TEXT, TYPE } from "./tokens";

/** What a titled panel sits on: its fill and the title's knockout. */
export type TitledSurface = "background" | "muted" | "surface" | "popover" | "raised";

const FILLS: Record<TitledSurface, string> = {
  background: "bg-background",
  muted: "bg-muted",
  surface: "bg-surface",
  popover: "bg-popover",
  raised: "bg-surface-raised",
};

/** The surface the nearest titled panel sits on: a nested panel's default, so its knockouts match. */
const SurfaceContext = context<(() => TitledSurface) | null>(null);

export interface TitledProps {
  /** The title on the top edge. Plain text. */
  title: string;
  /**
   * The fill it sits on, shared by the panel, the title's knockout and the
   * trailing slot's (default: the surface of the titled panel or finder
   * dialog it is in, else `background`). One token for all three, so a
   * knockout never reads as a chip of another shade.
   */
  surface?: TitledSurface;
  /** Its frame turns primary while the keyboard focus is inside (a finder's filter field: the one focus border). */
  focusWithin?: boolean;
  /** Content on the top edge at the right, 12pt in, on the same knockout (an "N / M" count). */
  trailing?: JSX.Element;
  /** Sizes and places the panel. */
  class?: string;
  /** Lays out its content. */
  bodyClass?: string;
  testID?: string;
  role?: AccessibilityRole;
  children?: JSX.Element;
}

/** A bordered panel titled on its top edge. */
export function Titled(props: TitledProps) {
  const parent = SurfaceContext();
  const surface = () => props.surface ?? parent?.() ?? "background";
  const fill = () => FILLS[surface()];
  return (
    <View
      class={cx("group", fill(), RADIUS, props.class ?? "")}
      testID={props.testID}
      role={props.role}
      accessibilityLabel={props.role ? props.title : undefined}
    >
      <View class={cx("flex-1", props.bodyClass ?? "")}>
        <SurfaceContext.Provider value={surface}>{props.children}</SurfaceContext.Provider>
      </View>
      <View
        testID={props.testID ? `${props.testID}-frame` : undefined}
        class={cx(
          "absolute inset-0 z-10 border border-border pointer-events-none",
          props.focusWithin ? "group-focus-within:border-primary" : "",
          RADIUS,
        )}
      />
      <View
        testID={props.testID ? `${props.testID}-title` : undefined}
        class={cx("absolute z-20 pointer-events-none", fill())}
        style={{ left: scaled(12), top: -scaled(9), paddingHorizontal: scaled(5) }}
      >
        <Text class={cx(TYPE.sm, "line-clamp-1 text-text-secondary")}>{props.title}</Text>
      </View>
      <If when={props.trailing}>
        <View
          testID={props.testID ? `${props.testID}-trailing` : undefined}
          class={cx("absolute z-20 flex-row items-center", fill())}
          style={{ right: scaled(12), top: -scaled(9), paddingHorizontal: scaled(5) }}
        >
          {props.trailing}
        </View>
      </If>
    </View>
  );
}

export interface FinderPanelProps extends Omit<TitledProps, "trailing"> {
  // `focusWithin` defaults to true here: a finder's field draws no border of
  // its own (Input `variant="plain"`), so the panel's line is its focus.
  /** The count on the top edge at the right ("3 / 12"), in mono caption. */
  count?: string | null;
}

/** A finder's titled panel (a field, or the results) with its count on the border. */
export function FinderPanel(props: FinderPanelProps) {
  return (
    <Titled
      {...props}
      focusWithin={props.focusWithin ?? true}
      trailing={
        props.count ? (
          <Text testID={props.testID ? `${props.testID}-count` : undefined} class={cx(TEXT.caption, TEXT.mono)}>
            {props.count}
          </Text>
        ) : undefined
      }
    />
  );
}
