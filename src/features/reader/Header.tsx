// The message's header: subject, sender, recipients, time. Every line is the
// sender's words and is drawn as plain text; the subject keeps its own
// direction (Direction.resolveSubject), the recipients clamp to two lines
// until asked, and each line has its copy menu.
import { Clipboard, computed, signal, Text, View, effect, untracked } from "nsh";
import { ContextMenuArea, MenuItem, ToolButton, FILL, TEXT, cx } from "../../ui";
import * as Mime from "../../mail/message/mime";
import * as Direction from "../../mail/message/direction";
import type { ReaderSummary } from "./store";

const KINDS = ["to", "cc", "bcc"] as const;
type Kind = (typeof KINDS)[number];
const PREFIX: Record<Kind, string> = { to: "To: ", cc: "Cc: ", bcc: "Bcc: " };

/** Whether a clamped line may hide recipients: more than fit two lines. */
export function recipientsOverflow(addresses: readonly Mime.Address[], width: number): boolean {
  const text = Mime.fullAddressList(addresses);
  // ~6pt per character at the caption size; two lines of the header's width.
  const perLine = Math.max(20, Math.floor(Math.max(0, width) / 6));
  return text.length > perLine * 2;
}

async function copy(text: string, what: string, note: (text: string) => void) {
  try {
    const written = await Clipboard.writeText(text);
    note(written === "written" ? what + " copied" : "Could not copy the " + what.toLowerCase());
  } catch {
    note("Could not copy the " + what.toLowerCase());
  }
}

function Recipients(props: { kind: Kind; summary: ReaderSummary; width: number; align: "left" | "right" | "auto"; note: (t: string) => void }) {
  const expanded = signal(false);
  const addresses = computed<Mime.Address[]>(() => (props.summary as any)[props.kind] ?? []);
  // A new message folds again.
  effect(() => {
    props.summary.id;
    untracked(() => expanded.set(false));
  });
  const line = computed(() => PREFIX[props.kind] + Mime.fullAddressList(addresses()));
  return (
    <If when={addresses().length > 0}>
      <View class="gap-0.5">
        <ContextMenuArea
          menu={<MenuItem label="Copy addresses" icon="copy" onSelect={() => copy(Mime.fullAddressList(addresses()), "Addresses", props.note)} />}
        >
          {() => (
            <Text
              testID={"reader-" + props.kind}
              class={TEXT.caption}
              style={{ numberOfLines: expanded() ? undefined : 2, textAlign: props.align }}
            >
              {line()}
            </Text>
          )}
        </ContextMenuArea>
        <If when={expanded() || recipientsOverflow(addresses(), props.width)}>
          <View class="flex-row">
            <ToolButton
              testID={"reader-" + props.kind + "-more"}
              label={expanded() ? "Show less" : "Show all " + addresses().length + " " + props.kind + " recipients"}
              onPress={() => expanded.set(!expanded())}
            />
          </View>
        </If>
      </View>
    </If>
  );
}

export interface HeaderProps {
  summary: ReaderSummary;
  width: number;
  onStar: () => void;
  onContinueDraft: () => void;
  note: (text: string) => void;
}

export function Header(props: HeaderProps) {
  const subjectDirection = computed(() => String(props.summary.subjectDirection || Direction.resolveSubject(props.summary.subject || "")));
  const align = computed<"left" | "right" | "auto">(() => {
    const d = subjectDirection();
    return d === "rtl" ? "right" : d === "ltr" ? "left" : "auto";
  });
  const from = computed(() => Mime.fullAddress(props.summary.from as Mime.Address));
  return (
    <View testID="reader-header" class="gap-1" selectable>
      <View class="flex-row items-start gap-2 pb-1">
        <View class="flex-1 min-w-0">
          <ContextMenuArea
            menu={<MenuItem label="Copy subject" icon="copy" onSelect={() => copy(props.summary.subject || "", "Subject", props.note)} />}
          >
            {(open) => (
              <Text
                testID="reader-subject"
                role="header"
                class={cx(TEXT.subject, open() && FILL.selected)}
                style={{ writingDirection: subjectDirection() === "rtl" ? "rtl" : subjectDirection() === "ltr" ? "ltr" : "auto", textAlign: align() }}
              >
                {props.summary.subject || "(no subject)"}
              </Text>
            )}
          </ContextMenuArea>
        </View>
        <View class="flex-row items-center gap-1" selectable={false}>
          <If when={props.summary.isDraft === true}>
            <ToolButton testID="reader-continue-draft" label="Continue editing" icon="edit" onPress={props.onContinueDraft} />
          </If>
          <ToolButton
            testID="reader-star"
            label={props.summary.starred ? "Unstar" : "Star"}
            icon="star"
            iconOnly
            selected={props.summary.starred === true}
            shortcut="s"
            onPress={props.onStar}
          />
        </View>
      </View>
      <ContextMenuArea
        menu={<MenuItem label="Copy address" icon="copy" onSelect={() => copy(String((props.summary.from as any)?.email || from()), "Address", props.note)} />}
      >
        {() => (
          <Text testID="reader-from" class={TEXT.listTitle} style={{ textAlign: align() }}>
            {from()}
          </Text>
        )}
      </ContextMenuArea>
      <Each of={KINDS} key={(k) => k}>
        {(kind) => <Recipients kind={kind()} summary={props.summary} width={props.width} align={align()} note={props.note} />}
      </Each>
      <If when={String(props.summary.fullTime || "") !== ""}>
        <Text testID="reader-time" class={cx(TEXT.caption, TEXT.mono)} style={{ textAlign: align() }}>
          {String(props.summary.fullTime || "")}
        </Text>
      </If>
    </View>
  );
}
