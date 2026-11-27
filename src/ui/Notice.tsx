// A line above content saying why it does not look the way it was meant
// to, and offering the one thing that would change that (ReaderNotice.qml).
//
// Notices stack, which is why this is one component: they share a height
// (one line, unless the reason needs a second beside its buttons), a fill
// and a gap, so content that trips two of them reads as two answers to two
// questions rather than as a bug. A notice has at most two actions, and two
// only when they are a narrower and a wider answer to the same question
// ("Show images" for this message before "Always show" for every message).
import { createMotion, Text, View, type JSX } from "nsh";
import { Button as OmButton } from "./Controls";
import { Icon, type IconKey } from "./Icon";
import { enterRise } from "./motion";
import { Titled } from "./Titled";
import { cx, FILL, LINE, RADIUS, TEXT, TONE_TEXT, TYPE, sizedBox, type Tone } from "./tokens";

type ViewStyleProp = ReturnType<typeof createMotion>["style"];

export interface NoticeAction {
  label: string;
  onPress: () => void;
  /** While the action is in flight: the button says so (`busyLabel`) rather than vanishing under the pointer. */
  busy?: boolean;
  /** The label while busy ("Loading images..."); the label otherwise. */
  busyLabel?: string;
  disabled?: boolean;
}

export interface NoticeProps {
  /** The reason, in this app's words. Plain text: a sender decides when a notice shows, never what it says. */
  text: string;
  /** `info` (default), `success`, `warning` or `danger`: the icon and its tint, never the color alone. */
  tone?: Tone;
  /** The glyph before the text; each tone has its own by default. */
  icon?: IconKey;
  /** The main answer, at the end. */
  action?: NoticeAction;
  /** A narrower answer to the same question, before the main one. Only with `action`. */
  secondaryAction?: NoticeAction;
  /**
   * Who or what the notice is about ("Agent", "Calendar"): drawn as a
   * `Titled` panel, the title on its top hairline, the tone icon and a 13pt
   * line inside, the actions ghost buttons. Plain text. Left out, the one-line
   * raised notice.
   */
  title?: string;
  testID?: string;
}

const TONE_ICON: Record<Tone, IconKey> = { info: "info", success: "success", warning: "warning", danger: "error" };

export function Notice(props: NoticeProps) {
  // Created once: a notice enters when it is added, not each time its text changes.
  const motion = createMotion({ enter: enterRise() });
  const tone = () => props.tone ?? "info";
  const alert = () => (tone() === "danger" || tone() === "warning" ? "alert" : undefined);
  const actions = () => (
    <>
      <If when={props.action && props.secondaryAction}>
        <NoticeButton action={props.secondaryAction!} testID={props.testID ? `${props.testID}-secondary` : undefined} />
      </If>
      <If when={props.action}>
        <NoticeButton action={props.action!} testID={props.testID ? `${props.testID}-action` : undefined} />
      </If>
    </>
  );
  return (
    <>
      <If when={props.title}>
        <View style={motion.style} class="pt-2">
          <Titled testID={props.testID} role={alert()} title={props.title!} bodyClass="flex-row items-center gap-2 pl-3 pr-1.5 pt-2.5 pb-1.5">
            <Icon name={props.icon ?? TONE_ICON[tone()]} size={14} class={TONE_TEXT[tone()]} />
            <Text class={cx(TYPE.md, "text-foreground flex-1 line-clamp-3")}>{props.text}</Text>
            {actions()}
          </Titled>
        </View>
      </If>
      <If when={!props.title}>
        <PlainNotice {...props} tone={tone()} role={alert()} actions={actions()} style={motion.style} />
      </If>
    </>
  );
}

function PlainNotice(props: NoticeProps & { tone: Tone; role: "alert" | undefined; actions: JSX.Element; style: ViewStyleProp }) {
  return (
    <View
      testID={props.testID}
      role={props.role}
      style={props.style}
      class={cx(sizedBox("min-h-[30px]", "min-h", 30), "flex-row items-center gap-2 py-1 pl-3 pr-1.5", FILL.raised, LINE.border, RADIUS)}
    >
      <Icon name={props.icon ?? TONE_ICON[props.tone]} size={14} class={TONE_TEXT[props.tone]} />
      <Text class={cx(TEXT.caption, "flex-1 line-clamp-3")}>{props.text}</Text>
      {props.actions}
    </View>
  );
}

function NoticeButton(props: { action: NoticeAction; testID?: string }) {
  const busy = () => !!props.action.busy;
  return (
    <OmButton
      testID={props.testID}
      label={busy() && props.action.busyLabel ? props.action.busyLabel : props.action.label}
      variant="ghost"
      size="small"
      loading={busy()}
      disabled={busy() || !!props.action.disabled}
      onPress={() => props.action.onPress()}
    />
  );
}

/** A notice in a stack, named so it keeps its place as others come and go. */
export interface NoticeItem extends NoticeProps {
  id: string;
}

export interface NoticeStackProps {
  /** The notices, top first. Each keeps its view by `id`; a new one enters, the others stay still. */
  items: readonly NoticeItem[];
  testID?: string;
}

/** Notices one above the other, the same gap apart; nothing at all while there are none. */
export function NoticeStack(props: NoticeStackProps) {
  return (
    <If when={props.items.length > 0}>
      <View testID={props.testID} class={cx("gap-1.5")}>
        <Each of={props.items} key={(n) => n.id}>
          {(n) => (
            <Notice
              testID={n().testID ?? `notice-${n().id}`}
              text={n().text}
              tone={n().tone}
              icon={n().icon}
              action={n().action}
              secondaryAction={n().secondaryAction}
              title={n().title}
            />
          )}
        </Each>
      </View>
    </If>
  );
}
