// The rows of the sidebar and the message list, with stable lanes
// (docs/DESIGN.md "Alignment spines"): an icon slot of fixed width, a label
// that takes the rest and elides, a suffix lane for counts and keys, a time
// lane on the trailing edge. Optional content never moves the remaining
// text: an absent icon keeps its slot, an absent count leaves its lane.
//
// Both rows are focusable, pressed by Space and Return and `selected` for
// screen readers. Their look is Visual language v2's: hover `surface-raised`;
// selected is the `selection` fill with brighter semibold text (no
// leading-edge bar); the keyboard focus is a 1pt primary ring inset on the
// row (`RING`, reserved so nothing moves, shown only for the keyboard).
// Selected wins over hover. Fills extend to the row's edges. In a
// virtualized list, pass the row's data as expressions (`title={row().subject}`)
// so a recycled cell follows its new item.
import { cleanup, context, effect, Text, untracked, View, type JSX, type KeyEvent, type ViewRef } from "nsh";
import type { RovingFocus } from "./roving";
import { chordLabel, Kbd } from "./Kbd";
import { Tooltip as OmTooltip } from "./Tooltip";
import { CountBadge, badgeText, UnreadDot } from "./Counts";
import { Icon, type IconKey } from "./Icon";
import { scaled } from "./font";
import { CLASS } from "./motion";
import { sizedBox, cx, FILL, RADIUS, RING, SELECTED_TEXT, SQUARE, TEXT, TYPE } from "./tokens";

/** Points each level of a nested row steps in. */
export const ROW_INDENT = 12;

export interface NavRowProps {
  /** The destination's name. Plain text: provider folders are named by servers. */
  label: string;
  icon?: IconKey;
  /** The open destination: the selected fill, the label in the foreground and bold. */
  selected?: boolean;
  /** A count worth showing in the suffix lane (unread in a label the user made); 0 shows none. */
  count?: number;
  /** Unread mail in it while it is not the open one: the label in the foreground and bold (with the count), not color alone. */
  unread?: boolean;
  /** Its view, for `measure()` (a drop target's bounds during a message drag). */
  rowRef?: (ref: ViewRef) => void;
  /** The digit of the key that opens it ("1"), shown in place of the count while modifiers are held: drawn as the whole chord this platform writes (⌘1, Ctrl+1), as the keys table binds it (Ctrl+1…9). A chord ("Alt+1") is drawn as given. */
  slotKey?: string;
  /** A name that opens nothing (an ancestor no label names): dimmed, still focusable. */
  dimmed?: boolean;
  /** Nesting level, one indent each. */
  depth?: number;
  /** The rail form: the icon centered, the label in a tooltip, a count as a corner dot. */
  collapsed?: boolean;
  /** A message dragged over it can be dropped here: a primary outline with the selection fill, not only a fill. */
  dropActive?: boolean;
  /** A disclosure chevron (a folder's fold), in the leading slot before the icon: its own press target. */
  leading?: JSX.Element;
  /** Keep the leading slot while `leading` is absent, so rows beside folders line up. */
  reserveLeading?: boolean;
  /** A control after the count lane, its own press target. Prefer `leading` for a fold chevron. */
  trailing?: JSX.Element;
  /** The full path for the tooltip, when it differs from the label ("Work/Clients"). */
  tooltipText?: string;
  /**
   * Whether Tab stops on the row (default true). A roving list sets it on
   * one row only (the stop), so Tab enters and leaves the list in one step
   * and the arrow keys move between rows.
   */
  focusable?: boolean;
  /**
   * Its key in the enclosing `NavList`'s `roving` focus: the row hands its
   * view to it and is a Tab stop only while it is the list's stop (over
   * `focusable`).
   */
  rovingKey?: string;
  onPress?: () => void;
  /** A secondary click asked for its menu: the row is its anchor. */
  onContextMenu?: () => void;
  testID?: string;
}

/** A NavList's keyboard: set as an arrow key moves the selection, so the newly selected row takes the focus. */
interface NavListState {
  moved: boolean;
  roving?: RovingFocus;
}
const NavListContext = context<NavListState | null>(null);

export type NavListStep = "previous" | "next" | "first" | "last";

export interface NavListProps {
  /** What screen readers call the list ("Mailboxes"). */
  accessibilityLabel: string;
  /**
   * An arrow key (Up / Down), Home or End asked to move the selection. The
   * owner selects that row (skipping what cannot be selected); the row that
   * becomes selected takes the focus, so the ring and the selection stay on
   * one row (roving focus).
   * Left out with `roving`, which moves and opens rows itself.
   */
  onMove?: (step: NavListStep) => void;
  /**
   * A tree's roving focus (`useRovingFocus`): it takes Up, Down, Home, End,
   * Left and Right while a row has the focus (folding, stepping in and out),
   * and its rows (`NavRow rovingKey`) are one Tab stop.
   */
  roving?: RovingFocus;
  children?: JSX.Element;
  class?: string;
  testID?: string;
}

/**
 * A column of `NavRow`s with roving focus (docs/DESIGN.md "Focus"): Up,
 * Down, Home and End move the selection itself, through `onMove`, and the
 * newly selected row takes the focus, so the ring and the selection sit on
 * one row. Set `focusable` on the stop row only (NavRow's `focusable`) so
 * Tab enters and leaves the list in one step.
 */
export function NavList(props: NavListProps) {
  const state: NavListState = { moved: false, roving: props.roving };
  const onKeyDown = (e: KeyEvent) => {
    if (props.roving || !props.onMove) return;
    const m = e.modifiers;
    if (m && (m.control || m.platform || m.alt || m.shift)) return;
    const step: NavListStep | null =
      e.key === "ArrowUp" ? "previous" : e.key === "ArrowDown" ? "next" : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
    if (!step) return;
    state.moved = true;
    props.onMove!(step);
  };
  return (
    <View
      testID={props.testID}
      role="list"
      accessibilityLabel={props.accessibilityLabel}
      onKeyDown={onKeyDown}
      onFocusIn={() => props.roving?.focusIn()}
      onFocusOut={() => props.roving?.focusOut()}
      class={props.class}
    >
      <NavListContext.Provider value={state}>{props.children}</NavListContext.Provider>
    </View>
  );
}

/** A slot's key as the chord that presses it: a bare digit is the table's Ctrl+digit (⌘3 on Apple platforms). */
export function slotChord(key: string): string {
  return chordLabel(/^\d$/.test(key) ? `Ctrl+${key}` : key);
}

export function NavRow(props: NavRowProps) {
  const list = NavListContext();
  let view: ViewRef | null = null;
  let unregister: (() => void) | null = null;
  cleanup(() => unregister?.());
  const roving = () => (props.rovingKey !== undefined ? list?.roving : undefined);
  const focusable = () => {
    const r = roving();
    return r ? r.isStop(props.rovingKey!) : props.focusable;
  };
  // In a NavList, the row an arrow key selected takes the focus.
  effect(() => {
    if (!props.selected || !list) return;
    untracked(() => {
      if (!list.moved) return;
      list.moved = false;
      view?.focus();
    });
  });
  const count = () => props.count ?? 0;
  const tip = () => {
    const base = props.tooltipText || props.label;
    return count() > 0 ? `${base} · ${count()}` : base;
  };
  const showTip = () => !!props.collapsed || !!props.tooltipText;
  return (
    // A pressable view rather than nsh/base's Button: a view takes
    // `focusable`, which a roving list needs (one Tab stop), and presses,
    // Space and Return the same way (ui.test.tsx checks Return and Space).
    // nsh/base's Button does not pass `focusable` through yet (NSH issue
    // draft: "nsh/base Button should pass `focusable` through"); return to
    // Button once it does.
    <View
      ref={(r: ViewRef) => {
        view = r;
        unregister?.();
        unregister = roving()?.register(props.rovingKey!, r) ?? null;
        props.rowRef?.(r);
      }}
      testID={props.testID}
      accessibilityLabel={
        props.slotKey
          ? `${props.label}, ${slotChord(props.slotKey)}`
          : count() > 0
            ? `${props.label}, ${badgeText(count(), 999)}`
            : props.label
      }
      role="button"
      accessibilityState={{ selected: !!props.selected }}
      focusable={focusable()}
      onPress={(e) => {
        props.onPress?.();
        // A pointer press makes the list the focused pane, as a native
        // sidebar does: the arrows work at once, and a focus that follows a
        // pointer shows no ring (focus-visible is the keyboard's). The next
        // frame: a roving list makes the pressed row its stop first.
        if (e.clickCount > 0) setTimeout(() => view?.focus(), 0);
      }}
      onContextMenu={props.onContextMenu ? () => props.onContextMenu!() : undefined}
      tooltip={showTip() ? <OmTooltip label={tip()} /> : undefined}
      class={cx(
        "group relative flex-row items-center",
        sizedBox("h-8", "h", 32),
        // The rail's item is a 32pt square, centred in the rail.
        props.collapsed ? cx("self-center justify-center px-0", sizedBox("w-8", "w", 32)) : "w-full gap-2 pr-3",
        RING.rest,
        RING.focus,
        // Selected wins over hover: the selection fill, never the hover wash.
        props.selected || props.dropActive ? FILL.selected : FILL.hover,
        FILL.pressed,
        CLASS.wash,
        // A drop target: a primary outline as well as the fill, so it is not color alone.
        props.dropActive ? RING.on : "",
      )}
      // 12pt from the edge to the first slot: the 1pt ring, then 11 of padding.
      style={props.collapsed ? undefined : { paddingLeft: scaled(11 + (props.depth ?? 0) * ROW_INDENT) }}
    >
      {/* The disclosure slot: a fold chevron, kept empty where asked so names line up. */}
      <If when={!props.collapsed && (props.leading || props.reserveLeading)}>
        <View class={cx("size-4 items-center justify-center -mr-1")}>{props.leading}</View>
      </If>
      {/* The icon slot: fixed, so labels line up whatever the glyph's bounds. */}
      <View class={cx("size-4 items-center justify-center")}>
        <If when={props.icon}>
          <Icon
            name={props.icon!}
            size={16}
            class={props.selected ? "text-bright" : props.dimmed ? "text-text-secondary opacity-60" : "text-text-secondary"}
          />
        </If>
      </View>
      <If when={!props.collapsed}>
        {/* The name takes every point the lanes leave, then elides. */}
        <Text
          class={cx(
            "flex-1 min-w-0 line-clamp-1",
            TYPE.md,
            props.selected
              ? SELECTED_TEXT
              : props.dimmed
                ? "text-text-secondary opacity-60"
                : props.unread
                  ? "text-foreground font-semibold"
                  : "text-text-secondary",
          )}
        >
          {props.label}
        </Text>
        {/* The count lane hugs its count (at least 20pt, right-aligned, tabular
            digits), so counts end on one right edge and the name keeps the
            rest. No count and no key: no lane and no gap. A key ("1") is a
            different thing from a count: a bordered 16pt cap. */}
        <If when={props.slotKey || badgeText(count(), 999) !== ""}>
          <View
            testID={props.testID ? `${props.testID}-count` : undefined}
            class={cx("flex-row items-center justify-end", sizedBox("min-w-5", "min-w", 20))}
          >
            <If when={props.slotKey} else={<CountBadge count={count()} />}>
              <Kbd testID={props.testID ? `${props.testID}-key` : undefined} keys={slotChord(props.slotKey!)} />
            </If>
          </View>
        </If>
        {props.trailing}
      </If>
      <If when={props.collapsed && count() > 0}>
        <View class={cx("absolute right-[3px] top-1")}>
          <UnreadDot unread size="small" />
        </View>
      </If>
    </View>
  );
}

/** The props of an nsh `View`, for the events ListRow passes through. */
type ViewHostProps = Parameters<typeof View>[0];

export interface ListRowProps {
  /** What screen readers call the row ("Ada Lovelace, Lunch on Friday, 10:24"). */
  accessibilityLabel?: string;
  /** "button" (default), or "row" / "option" inside a list that owns the cursor. */
  role?: "button" | "row" | "option";
  /** The first line: who it is from. */
  overline?: string;
  /** Beside the overline, before the time: a mailbox name. Named in words, never a tint alone. */
  meta?: JSX.Element;
  /** Messages in the thread (shown from 2): a count chip of its own before the time, so it never reads as part of it. */
  threadCount?: number;
  /** The trailing time ("10:24"), in tabular digits on the overline's line. */
  time?: string;
  /** The main line: the subject. */
  title: string;
  /** The last line, one line at most: the snippet. */
  detail?: string;
  /** Unread: the lead dot, and the title and overline in bold. */
  unread?: boolean;
  /** The row the reader shows, or checked: the selected fill (screen readers hear "selected"). */
  selected?: boolean;
  /** Under the keyboard cursor while not selected: the hover fill. (In a message list the cursor is the selection; prefer `selected`.) */
  cursor?: boolean;
  /** Checked in a multi-selection: told to screen readers (the fill is `selected`'s). */
  checked?: boolean;
  /** Controls that are state, not actions, always at the end of the title line (a selection checkbox in select mode). Quick actions are `quickActions`. */
  actions?: JSX.Element;
  /** Show the quick actions now, as on hover (the row's menu is open). */
  actionsShown?: boolean;
  /**
   * The row's quick actions (Archive, Delete, Star): while the row is
   * hovered, selected, holds the focus or `actionsShown`, they take the place
   * of the first line's trailing metadata (the thread count and the time go
   * together), ending where the time ended; no column is reserved. Every
   * quick action must also be in the row's context menu and the keymap.
   * They are for the pointer only: they are
   * no Tab stops (a long list stays one stop, its keys are the keymap's and
   * the row menu's), and screen readers get them as the row's own
   * accessibility actions.
   */
  quickActions?: readonly RowQuickAction[];
  /** A hint on the time (`<ShortcutTooltip label="Friday 21 November 2026, 10:24" />`). */
  timeTooltip?: JSX.Element;
  /** A fixed 72pt row (scaled with the base size): three lines 6 apart, centred; an empty detail keeps its line. For lists of rows of one height. */
  fixedHeight?: boolean;
  /** Square corners whatever the theme's radius: for rows that meet edge to edge. */
  flush?: boolean;
  /** A click, Enter or Space: `e.modifiers` carries Ctrl / Shift / Meta for toggle and range, `e.clickCount` 0 from the keyboard. */
  onPress?: (e: Parameters<NonNullable<ViewHostProps["onPress"]>>[0]) => void;
  onContextMenu?: () => void;
  onMouseEnter?: ViewHostProps["onMouseEnter"];
  onMouseLeave?: ViewHostProps["onMouseLeave"];
  onMouseMove?: ViewHostProps["onMouseMove"];
  /** Any button's release; `e.button === "middle"` for a middle click. */
  onMouseUp?: ViewHostProps["onMouseUp"];
  /** Drag pass-through (dragging rows to the sidebar). */
  pan?: ViewHostProps["pan"];
  panActivation?: ViewHostProps["panActivation"];
  onPanStart?: ViewHostProps["onPanStart"];
  onPanEnd?: ViewHostProps["onPanEnd"];
  /** Animated style from the caller's motion (an entrance); layout stays the row's. */
  style?: ViewHostProps["style"];
  /** The row's view, for `reveal()` or focus. */
  rowRef?: (ref: ViewRef) => void;
  testID?: string;
}

/** A quick action of a list row (`ListRow quickActions`). */
export interface RowQuickAction {
  /** Stable name, what an assistive technology performs ("archive"). */
  name: string;
  /** What it does ("Archive"): the tooltip and what screen readers say. */
  label: string;
  icon: IconKey;
  /** The keymap's chord, shown in the tooltip ("e"). */
  shortcut?: string;
  /** A toggle that is on (a filled star). */
  selected?: boolean;
  onPerform: () => void;
}

/** The row's accessibility actions for its quick actions, and the handler that performs one by name. */
export function quickActionsA11y(actions: readonly RowQuickAction[]): {
  accessibilityActions: { name: string; label: string }[];
  perform: (name: string) => boolean;
} {
  return {
    accessibilityActions: actions.map((a) => ({ name: a.name, label: a.label })),
    perform: (name) => {
      const action = actions.find((a) => a.name === name);
      if (!action) return false;
      action.onPerform();
      return true;
    },
  };
}

/** A lane action: a pressable icon for the pointer, no Tab stop (the row offers it to screen readers). */
function LaneAction(props: { action: RowQuickAction; testID?: string }) {
  return (
    <View
      testID={props.testID}
      focusable={false}
      role="button"
      accessibilityLabel={props.action.label}
      accessibilityState={{ selected: !!props.action.selected }}
      onPress={() => props.action.onPerform()}
      tooltip={<OmTooltip label={props.action.label} shortcut={props.action.shortcut ?? null} />}
      class={cx(
        "group items-center justify-center",
        SQUARE.small,
        RADIUS,
        FILL.hover,
        FILL.pressed,
        CLASS.pressIcon,
        props.action.selected ? "text-bright" : "text-foreground hover:text-bright",
      )}
    >
      <Icon name={props.action.icon} filled={props.action.selected} />
    </View>
  );
}

/** A message summary: overline and time, title, detail; the unread lane at the lead. */
export function ListRow(props: ListRowProps) {
  const quick = () => props.quickActions ?? [];
  const laneActions = () => quick().length > 0;
  const a11y = () => quickActionsA11y(quick());
  const shown = () => !!props.selected || !!props.actionsShown;
  const metaHidden = () =>
    shown() ? "opacity-0" : "group-hover:opacity-0 group-focus-visible:opacity-0 group-focus-within:opacity-0";
  return (
    <View
      testID={props.testID}
      ref={(node: ViewRef) => props.rowRef?.(node)}
      focusable
      role={props.role ?? "button"}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: !!props.selected, checked: !!props.checked }}
      accessibilityActions={quick().length > 0 ? a11y().accessibilityActions : undefined}
      onAccessibilityAction={(e) => {
        a11y().perform(e.actionName);
      }}
      onPress={(e) => props.onPress?.(e)}
      onContextMenu={props.onContextMenu ? () => props.onContextMenu!() : undefined}
      onMouseEnter={(e) => props.onMouseEnter?.(e)}
      onMouseLeave={(e) => props.onMouseLeave?.(e)}
      onMouseMove={props.onMouseMove ? (e) => props.onMouseMove!(e) : undefined}
      onMouseUp={(e) => props.onMouseUp?.(e)}
      pan={props.pan}
      panActivation={props.panActivation}
      onPanStart={props.onPanStart ? (e) => props.onPanStart!(e) : undefined}
      onPanEnd={props.onPanEnd ? (e) => props.onPanEnd!(e) : undefined}
      style={props.style}
      class={cx(
        "group relative w-full flex-row pl-3 pr-3",
        props.fixedHeight ? cx(sizedBox("h-[72px]", "h", 72), "items-center") : "py-2.5",
        props.flush ? "" : RADIUS,
        RING.rest,
        RING.focus,
        // Selected wins over hover: the selection fill, never the hover wash.
        // A keyboard cursor away from the selection takes the hover fill
        // (a ring would read as a second selection).
        props.selected ? FILL.selected : props.cursor ? FILL.raised : FILL.hover,
        FILL.pressed,
        CLASS.wash,
      )}
    >
      <View class={cx("flex-1 min-w-0 gap-1.5")}>
        <View class={cx("relative flex-row items-baseline gap-2")}>
          {/* The dot in the lead padding, centred on the overline's line. */}
          <View testID={props.testID ? `${props.testID}-dot` : undefined} class={cx("absolute -left-2.5 top-0 bottom-0 justify-center")}>
            <UnreadDot unread={!!props.unread} size="small" />
          </View>
          <Text
            class={cx(
              TYPE.md,
              "flex-1 min-w-0 line-clamp-1",
              props.selected ? SELECTED_TEXT : props.unread ? "font-semibold text-foreground" : "text-text-secondary",
            )}
          >
            {props.overline ?? ""}
          </Text>
          {/* The trailing metadata, ending on the row's trailing edge. Quick
              actions take its place while they show. */}
          <View
            testID={props.testID ? `${props.testID}-meta` : undefined}
            class={cx("flex-row items-baseline gap-2", laneActions() ? metaHidden() : "", "transition-opacity duration-[120ms] ease-out motion-reduce:transition-none")}
          >
            {props.meta}
            <If when={(props.threadCount ?? 0) > 1}>
              <ThreadCount count={props.threadCount!} testID={props.testID ? `${props.testID}-thread` : undefined} />
            </If>
            <If when={props.time}>
              <Text tooltip={props.timeTooltip} class={cx(TEXT.caption, TEXT.mono)}>
                {props.time}
              </Text>
            </If>
          </View>
          <If when={laneActions()}>
            {/* Quick actions over the metadata: shown while the row is hovered,
                selected or holds the focus (Tab reaches them in place);
                hidden, they take no press, so a click there is the row's. */}
            <View
              testID={props.testID ? `${props.testID}-actions` : undefined}
              class={cx(
                "absolute right-0 top-0 bottom-0 flex-row items-center justify-end gap-1",
                shown()
                  ? "opacity-100"
                  : cx(
                      "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
                      "group-focus-visible:opacity-100 focus-within:opacity-100 focus-within:pointer-events-auto",
                    ),
                "transition-opacity duration-[120ms] ease-out motion-reduce:transition-none",
              )}
            >
              {quick().map((action) => (
                <LaneAction action={action} testID={props.testID ? `${props.testID}-${action.name}` : undefined} />
              ))}
            </View>
          </If>
        </View>
        <View class={cx("flex-row items-center gap-1")}>
          <Text
            class={cx(
              TYPE.body,
              "flex-1 min-w-0 line-clamp-1",
              props.selected ? SELECTED_TEXT : props.unread ? "font-semibold text-bright" : "text-foreground",
            )}
          >
            {props.title}
          </Text>
          {props.actions}
        </View>
        <If when={props.detail || props.fixedHeight}>
          {/* A fixed row keeps the detail's line when there is none. */}
          <Text class={cx(TEXT.caption, "line-clamp-1")}>{props.detail || " "}</Text>
        </If>
      </View>
    </View>
  );
}

export interface ThreadCountProps {
  /** Messages in the thread. */
  count: number;
  testID?: string;
}

/** A thread's message count as a chip of its own: mono caption in a hairline, so "3" never joins the time beside it. */
export function ThreadCount(props: ThreadCountProps) {
  return (
    <View
      testID={props.testID}
      accessibilityLabel={`${props.count} messages`}
      class={cx("h-4 min-w-4 px-1 items-center justify-center border border-border", FILL.raised, RADIUS)}
    >
      <Text class={cx(TYPE.xs, TEXT.mono, "text-text-secondary leading-none")}>{String(props.count)}</Text>
    </View>
  );
}
