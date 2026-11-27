// The status line (Visual language v2, after NsVim's): 28 tall on the muted
// well. At the left a filled pill names the place (INBOX, COMPOSE, SETTINGS,
// CALENDAR), then the account, the ticked count and what is in flight; on
// the right either a notice or the keys useful from here as key caps. Port
// of App.qml's `statusBar`. A notice replaces the hints, because it is what
// the window most needs to say.
import { signal, Text, View } from "nsh";
import { app, type Page } from "../app/store";
import { mailboxStore } from "../features/mailbox";
import { labelIdOfMailbox, type Label } from "../mail/labels";
import { hasCommand, keyReport, runCommand } from "../keys/commands";
import * as Keys from "../keys/keymap";
import { keyCaps } from "../keys/labels";
import { keyContext } from "../keys/router";
import { Button, cx, FILL, Kbd, LINE, sizedBox, StatusPill, TEXT, TYPE } from "../ui";
import { AccountMenu } from "./AccountMenu";
import type { Mode } from "./layout";

/** "3 selected", as the Qt bar said it. */
export function selectionStatus(count: number): string {
  return count === 1 ? "1 selected" : count + " selected";
}

/** What the place pill says, in capitals: the page, or over mail the
 * mailbox's own name (a label's last segment). Names are the user's or the
 * server's; they are drawn as plain text. */
export function placeName(input: {
  page: Page;
  composing: boolean;
  mailbox: string;
  mailboxes: readonly { key: string; label: string }[];
  labels: readonly Label[];
}): string {
  if (input.composing) return "COMPOSE";
  if (input.page === "settings") return "SETTINGS";
  if (input.page === "setup") return "SETUP";
  if (input.page === "calendar") return "CALENDAR";
  const entry = input.mailboxes.find((m) => m.key === input.mailbox);
  if (entry) return entry.label.toUpperCase();
  const id = labelIdOfMailbox(input.mailbox);
  if (id !== "") {
    const label = input.labels.find((l) => l.id === id);
    const name = String(label?.name ?? label?.rawName ?? id);
    const leaf = name.split(label?.delimiter ?? "/").filter((part) => part !== "").pop() ?? name;
    return leaf.toUpperCase();
  }
  return "MAIL";
}

export interface StatusBarProps {
  mode: Mode;
}

export function StatusBar(props: StatusBarProps) {
  const hintsWidth = signal(0);
  const barWidth = signal(0);
  const leftWidth = signal(0);
  const report = () => keyReport();
  const notice = () => {
    if (app.notice() !== "") return app.notice();
    return report().lastError ?? "";
  };
  const isError = () => app.notice() === "" && (report().lastError ?? "") !== "";
  const hints = () => Keys.hintsFor(keyContext(), report().unavailable ?? [], app.cursorId() !== "", report().actions ?? null)
    .map((h) => ({ caps: keyCaps(h.key), label: h.label }));
  // Hints are a nicety and the address a fact: they step off whole rather
  // than arrive cut in half.
  const hintsFit = () => barWidth() - leftWidth() - 24 >= hintsWidth();
  const selecting = () => app.checked().length > 0 && !app.showPage() && !app.composing();
  const place = () => placeName({
    page: app.page(),
    composing: app.composing(),
    mailbox: app.mailbox(),
    mailboxes: mailboxStore.mailboxes(),
    labels: mailboxStore.labels(),
  });
  return (
    <View
      testID="status-bar"
      class={cx(sizedBox("h-7", "h", 28), "flex-row items-center gap-2 border-t pr-3", LINE.divider, FILL.inset)}
      onLayout={(e) => barWidth.set(e.bounds.size.width)}
    >
      <View class={cx("flex-row items-center gap-2 shrink pl-1")} onLayout={(e) => leftWidth.set(e.bounds.size.width)}>
        <StatusPill testID="status-place" label={place()} class={cx(sizedBox("max-w-[160px]", "max-w", 160))} />
        <If when={selecting()}>
          <Text testID="status-selection" class={cx(TEXT.captionStrong, "font-semibold")}>
            {selectionStatus(app.checked().length)}
          </Text>
        </If>
        <If when={(report().activity ?? "") !== "" && !app.showPage()}>
          <Text testID="status-activity" class={cx(TEXT.caption, sizedBox("max-w-[360px]", "max-w", 360), "line-clamp-1")}>
            {report().activity ?? ""}
          </Text>
        </If>
        <AccountMenu />
      </View>
      <View class="flex-1" />
      <If when={notice() !== ""}>
        <View class={cx("flex-row items-center gap-2 shrink")}>
          <Text
            testID="status-notice"
            class={cx(isError() ? TYPE.sm + " " + TEXT.danger : TEXT.caption, "line-clamp-1")}
            accessibilityLiveRegion="polite"
          >
            {isError() ? "Error: " + notice() : notice()}
          </Text>
          <If when={isError() && hasCommand("diagnoseError")}>
            <Button label="Diagnose with AI..." size="small" variant="ghost" onPress={() => runCommand("diagnoseError")} />
          </If>
        </View>
      </If>
      <If when={notice() === "" && props.mode !== "compact"}>
        <View
          testID="status-key-hints"
          class={hintsFit() ? "opacity-100" : "opacity-0"}
          accessibilityElementsHidden={!hintsFit()}
          onLayout={(e) => hintsWidth.set(e.bounds.size.width)}
        >
          {/* One cap per key (⇧J ⇧K), not KeyHints' one cap per hint. */}
          <View class={cx("flex-row items-center gap-3")} accessibilityLabel="Keyboard shortcuts">
            <Each of={hints()} key={(h) => `${h.caps.join(" ")}\u0000${h.label}`}>
              {(hint) => (
                <View class={cx("flex-row items-center gap-1")}>
                  <Each of={hint().caps} key="index">{(cap) => <Kbd keys={cap()} size="compact" />}</Each>
                  <Text class={cx(TEXT.caption, "leading-none")}>{hint().label}</Text>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>
    </View>
  );
}
