// Feature entry: the shell imports only what this file exports.
//
// The reader: the open message's header, the notices that explain how it is
// drawn, the invitation and the agent's findings, the body, its attachments,
// and the action bar on the reader's lower edge (MessageReader.qml,
// ReaderNotice.qml, ReaderBlankSlate.qml, ReaderSkeleton.qml).
import { computed, effect, reduceMotion, Scroll, signal, Text, untracked, View, type ScrollRef } from "nsh";
import {
  ActionBar, ActionBarGroup, ActionBarSeparator, ActionBarSpacer, Button, Tooltip, confirmAction, EmptyPane, Icon, Kbd,
  NoticeStack, ReaderSkeleton, SegmentedControl, ToolButton, TEXT, LINE, RADIUS, cx, scaled, sizedBox,
  type NoticeItem, type SegmentOption,
} from "../../ui";
import { app } from "../../app/store";
import { registerCommand } from "../../keys/commands";
import { openMovePicker } from "../mailbox";
import * as Keys from "../../keys/keymap";
import { listStore } from "../list/store";
import { actionName } from "../../mail/listModel";
import { mailboxes } from "../../mail/providers/registry";
import * as Images from "../../mail/message/images";
import { formatSize } from "../../mail/message/mime";
import type { BodyMode } from "../../mail/message/html";
import { imageLinkIndex } from "../../mail/message/html";
import { Body, zoomLabel } from "./Body";
import { Header } from "./Header";
import { InviteCard, SuggestionsCard } from "./Cards";
import { ImageViewer, openViewer } from "./ImageViewer";
import { readerPrefs } from "./prefs";
import { registerReaderAssistant, useEventSuggestions } from "./assistant";
import { reader, useReader } from "./store";

export { reader } from "./store";
export { readerPrefs } from "./prefs";

/** The page's one inset at base 14: 24, and 12 when the pane is narrow. */
export function pageInset(width: number): number {
  return width > 0 && width < 420 ? 12 : 24;
}

const MODES: readonly SegmentOption<BodyMode>[] = [
  { value: "reader", label: "Reader", tooltip: "Rebuild this message for reading" },
  { value: "original", label: "Original", tooltip: "Show the sender's own formatting" },
  { value: "plain", label: "Plain", tooltip: "Show plain text" },
];

/** Asks before leaving the app for a sender's link, naming where it goes. */
function confirmLink(target: string): Promise<boolean> {
  return confirmAction({
    title: "Open this link in your browser?",
    description: target,
    actionLabel: "Open link",
  });
}

// ------------------------------------------------------------------ notices

export function blockedText(count: number): string {
  return (count === 1 ? "1 image is blocked" : count + " images are blocked")
    + ": loading them tells the sender this message was opened";
}

const notices = computed<NoticeItem[]>(() => {
  const out: NoticeItem[] = [];
  const summary = reader.summary();
  if (!summary) return out;
  if (reader.tooHeavy()) {
    out.push({
      id: "heavy", tone: "warning", text: "Showing the plain text: this message is heavy enough to stall the shell",
      action: { label: "Show anyway", onPress: () => reader.forceRich() },
    });
  }
  if (reader.readingEmpty()) {
    out.push({ id: "empty-reading", tone: "info", text: "Showing the sender's own formatting: there was nothing here to rebuild" });
  }
  if (!reader.loading() && reader.painted() && reader.body().source === "" && !reader.hasHtml() && reader.attachments().length === 0) {
    out.push({
      id: "no-text", tone: "info", text: "This message has no text to show",
      action: reader.canOpenOnWeb() ? { label: "Open on the web...", onPress: () => void listStore.openInBrowser(reader.id()) } : undefined,
    });
  }
  if (reader.shownMode() !== "plain" && !reader.remoteAllowed() && reader.blockedCount() > 0) {
    out.push({
      id: "blocked-images", tone: "info", icon: "eyeOff", text: blockedText(reader.blockedCount()),
      secondaryAction: { label: "Show images", onPress: () => reader.showMessageImages() },
      action: { label: "Always show", onPress: () => reader.alwaysShowImages() },
    });
  }
  if (reader.remoteAllowed() && reader.remoteLoading()) {
    out.push({ id: "loading-images", tone: "info", icon: "loading", text: "Loading images..." });
  }
  const detail = reader.unsubscribeDetail();
  if (detail !== "") {
    const label = reader.unsubscribeLabel();
    out.push({
      id: "unsubscribe", tone: "info", icon: "unsubscribe", text: detail,
      action: label !== "" ? {
        label, busy: reader.unsubscribing(), busyLabel: "Unsubscribing...",
        onPress: () => void reader.runUnsubscribe(confirmLink),
      } : undefined,
    });
  }
  return out.map((n) => ({ ...n, title: NOTICE_TITLE[n.id] ?? "Notice" }));
});

/** Each notice's title on its panel's edge: what the notice is about. */
const NOTICE_TITLE: Record<string, string> = {
  heavy: "Large message",
  "empty-reading": "Reader view",
  "no-text": "Message",
  "blocked-images": "Remote images",
  "loading-images": "Remote images",
  unsubscribe: "Mailing list",
};

// ------------------------------------------------------------------ attachments

function Attachments(props: { onOpen: (attachment: Images.Attachment) => void }) {
  const expanded = signal(false);
  effect(() => {
    reader.id();
    untracked(() => expanded.set(false));
  });
  const files = () => reader.attachments();
  return (
    <If when={files().length > 0}>
      <View testID="attachments" class="gap-1">
        <View class="flex-row">
          {/* ui's outlined ToolButton, so its box is the edge on the page's
              spine (with the header above and the panel below), open or
              closed: a ghost would leave its paperclip floating with no edge. */}
          <ToolButton
            testID="attachment-toggle"
            outline
            icon="attachment"
            label={files().length + (files().length === 1 ? " attachment" : " attachments") + (expanded() ? " · Hide" : " · Show")}
            selected={expanded()}
            onPress={() => expanded.set(!expanded())}
          />
        </View>
        <If when={expanded()}>
          <View class={cx(LINE.border, RADIUS, sizedBox("max-h-48", "max-h", 192))}>
            <Scroll contentClass="py-1">
              <Each of={files()} key={(f, i) => String(f.attachmentId || i)}>
                {(file) => (
                  <View class={cx("flex-row items-center gap-2 px-2", sizedBox("h-7", "h", 28))}>
                    <Icon name={Images.viewable(file()) ? "image" : "file"} size={14} class={TEXT.secondary} />
                    <View class="flex-1 min-w-0 flex-row">
                      <Button
                        label={String(file().filename || "attachment")}
                        variant="ghost"
                        size="small"
                        tooltip={<Tooltip label="Open attachment" />}
                        accessibilityLabel={"Open " + String(file().filename || "attachment")}
                        onPress={() => props.onOpen(file())}
                      />
                    </View>
                    <Text class={cx(TEXT.caption, TEXT.mono)}>{formatSize(file().size)}</Text>
                    <ToolButton
                      label={reader.saving(String(file().attachmentId || "")) ? "Saving..." : "Save to Downloads"}
                      icon="download"
                      iconOnly
                      loading={reader.saving(String(file().attachmentId || ""))}
                      onPress={() => void reader.saveAttachment(file())}
                    />
                  </View>
                )}
              </Each>
            </Scroll>
          </View>
        </If>
      </View>
    </If>
  );
}

// ------------------------------------------------------------------ blank slate

function mailboxLabel(): string {
  const account = app.account() ?? app.accounts()[0];
  const key = app.mailbox() || "inbox";
  if (key.startsWith("label:")) return "Label";
  const found = mailboxes(account?.provider ?? "gmail").find((box) => box.key === key);
  return found ? found.label : "Inbox";
}

export function blankSubtitle(state: { loading: boolean; count: number; searching: boolean }): string {
  if (state.loading && state.count === 0) return "Fetching the mailbox";
  if (state.count === 0) return state.searching ? "Nothing matches that search" : "Nothing here";
  return "Pick a message to read it";
}

function BlankSlate() {
  const searching = () => app.query() !== "";
  const count = () => listStore.messages().length;
  const empty = () => !listStore.loading() && count() === 0;
  const legend = computed(() => {
    listStore.messages();
    return [
      { key: "j / k", action: "Move through the list" },
      { key: "Enter or o", action: "Open the selected message" },
      { key: "e", action: actionName(listStore.keyAction("archive") || "archive") },
      { key: "d", action: actionName(listStore.keyAction("trash") || "trash") },
      { key: Keys.keycapLabel(Keys.hintKeyFor(Keys.byId("toggleCheck"))), action: "Select or deselect a message" },
      { key: "r", action: "Reply" },
      { key: "c", action: "Compose" },
    ];
  });
  const title = () => {
    const q = app.query();
    return searching() ? "\"" + (q.length > 36 ? q.substring(0, 35) + "…" : q) + "\"" : mailboxLabel();
  };
  return (
    <View testID="reader-blank" class="flex-1 items-center justify-center gap-4 p-6">
      <EmptyPane
        instant
        title={title()}
        description={blankSubtitle({ loading: listStore.loading(), count: count(), searching: searching() })}
        icon={searching() ? "search" : "mail"}
      />
      <If when={!empty()}>
        <View class="gap-1.5" accessibilityLabel="Keyboard shortcuts">
          <Each of={legend()} key={(row) => row.key}>
            {(row) => (
              <View class="flex-row items-center gap-3">
                <View class={cx(sizedBox("w-24", "w", 96), "items-end")}><Kbd keys={row().key} /></View>
                <Text class={TEXT.caption}>{row().action}</Text>
              </View>
            )}
          </Each>
          <Text class={cx(TEXT.caption, "pt-2 text-center")}>? for every shortcut</Text>
        </View>
      </If>
    </View>
  );
}

// ------------------------------------------------------------------ footer

function Footer() {
  const id = () => reader.id();
  const summary = () => reader.summary();
  const archiveAction = computed(() => {
    listStore.messages();
    return listStore.keyAction("archive", [id()]) || "archive";
  });
  const trashAction = computed(() => {
    listStore.messages();
    return listStore.keyAction("trash", [id()]) || "trash";
  });
  const caps = computed(() => listStore.capabilitiesFor(id()));
  return (
    <ActionBar label="Message actions" edge="bottom" testID="reader-actions">
      <If when={summary()?.isDraft !== true}>
        <ActionBarGroup label="Answer">
          <ToolButton label="Reply" icon="reply" iconOnly shortcut="r" onPress={() => reader.compose("reply")} />
          <ToolButton label="Reply all" icon="replyAll" iconOnly shortcut="a" onPress={() => reader.compose("replyAll")} />
          <ToolButton label="Forward" icon="forward" iconOnly shortcut="f" onPress={() => reader.compose("forward")} />
        </ActionBarGroup>
        <ActionBarSeparator />
      </If>
      <ActionBarGroup label="File">
        <If when={caps().archive}>
          <ToolButton
            testID="reader-archive"
            label={actionName(archiveAction())}
            icon={archiveAction() === "unarchive" ? "inbox" : "archive"}
            iconOnly
            shortcut="e"
            onPress={() => listStore.act(archiveAction(), [id()])}
          />
        </If>
        <If when={caps().move || caps().labels}>
          <ToolButton
            label="Move to..."
            icon="label"
            iconOnly
            shortcut="v"
            onPress={() => {
              openMovePicker([id()], (labelId, ids) => listStore.act("label:" + labelId, ids));
            }}
          />
        </If>
        <ToolButton
          testID="reader-trash"
          label={actionName(trashAction())}
          icon={trashAction() === "untrash" ? "undo" : "trash"}
          iconOnly
          shortcut="d"
          onPress={() => listStore.act(trashAction(), [id()])}
        />
      </ActionBarGroup>
      <ActionBarSpacer />
      {/* The body's zoom, shown only while it is not 100%: a zoom nobody can
          see reads as a broken font size. Pressing it (or Ctrl+0) resets. */}
      <If when={readerPrefs.zoom() !== 1}>
        <ToolButton
          testID="reader-zoom"
          label={zoomLabel(readerPrefs.zoom())}
          accessibilityLabel={"Message zoom " + zoomLabel(readerPrefs.zoom()) + ". Reset to 100%"}
          shortcut="mod-0"
          onPress={() => readerPrefs.resetZoom()}
        />
      </If>
      <If when={reader.hasHtml()}>
        <SegmentedControl
          testID="reader-mode"
          label="How to show this message"
          options={MODES}
          value={readerPrefs.bodyMode()}
          onChange={(mode) => readerPrefs.setBodyMode(mode)}
        />
      </If>
      <If when={caps().web}>
        <ToolButton label="Open in browser" icon="browser" iconOnly shortcut="b" onPress={() => void listStore.openInBrowser(id())} />
      </If>
    </ActionBar>
  );
}

// ------------------------------------------------------------------ the reader

function Message() {
  const width = signal(0);
  const viewport = signal(0);
  let scroll: ScrollRef | null = null;
  let offset = 0;
  let contentHeight = 0;
  const inset = () => scaled(pageInset(width()));
  effect(() => {
    reader.id();
    untracked(() => {
      offset = 0;
      scroll?.scrollTo({ y: 0, animated: false });
    });
  });

  function scrollBy(steps: number) {
    if (!scroll) return;
    const step = Math.max(40, Math.round(viewport() * 0.15));
    const max = Math.max(0, contentHeight - viewport());
    offset = Math.max(0, Math.min(max, offset + steps * step));
    scroll.scrollTo({ y: offset, animated: !reduceMotion() });
  }
  // Answering the open message (KEYS.md): a draft is continued, not answered.
  const answer = (mode: "reply" | "replyAll" | "forward") => () => {
    if (reader.summary()?.isDraft === true) reader.compose("draft");
    else reader.compose(mode);
  };
  registerCommand("reply", answer("reply"));
  registerCommand("replyAll", answer("replyAll"));
  registerCommand("forward", answer("forward"));
  registerCommand("scrollDown", () => scrollBy(1));
  registerCommand("scrollUp", () => scrollBy(-1));

  function gallery(): Images.GalleryEntry[] {
    return Images.gallery(reader.shownImages(), reader.attachments(), reader.shownMode() === "plain");
  }

  function onLink(url: string) {
    const picture = imageLinkIndex(url);
    if (picture > 0) {
      if (picture <= reader.shownImages().length) openViewer(gallery(), picture - 1);
      return;
    }
    void reader.openLink(url, confirmLink);
  }

  // A picture attachment opens in the viewer; anything else in another app.
  function openAttachment(attachment: Images.Attachment) {
    const entries = Images.viewable(attachment) ? gallery() : [];
    const at = Images.attachmentIndex(entries, attachment);
    if (at >= 0) openViewer(entries, at);
    else void reader.openAttachment(attachment);
  }

  const bodyWidth = () => Math.max(80, width() - inset() * 2);
  return (
    <View class="flex-1" onLayout={(e) => width.set(e.bounds.size.width)}>
      <Scroll
        testID="messageBodyScroller"
        class="flex-1"
        ref={(ref) => (scroll = ref)}
        onLayout={(e) => viewport.set(e.bounds.size.height)}
        onScroll={(e) => {
          offset = e.offset.y;
          contentHeight = e.contentSize.height;
        }}
        contentStyle={{ paddingHorizontal: inset(), paddingTop: inset(), paddingBottom: scaled(32) }}
      >
        <View class="gap-3">
          <If when={reader.summary()}>
            {(s) => (
              <Header
                summary={s()}
                width={bodyWidth()}
                note={(text) => app.setNotice(text)}
                onStar={() => listStore.actSlot("star", [reader.id()])}
                onContinueDraft={() => reader.compose("draft")}
              />
            )}
          </If>
          <If when={notices().length > 0}>
            <NoticeStack items={notices()} testID="reader-notices" />
          </If>
          <If when={reader.invite()}>
            {(found) => (
              <InviteCard
                invite={found()}
                response={reader.response()}
                canRespond={reader.canRespond()}
                sending={reader.rsvpSending() || reader.calendarState().busy}
                calendarState={reader.calendarState()}
                onSaveCalendar={() => reader.retryCalendar()}
                fallbackAvailable={reader.rsvpFallback()}
                calendarUrl={reader.calendarUrl()}
                onRespond={(answer) => void reader.rsvp(answer)}
                onMailOnly={(answer) => void reader.rsvp(answer, true)}
                onOpen={(url) => void reader.openLink(url, confirmLink)}
              />
            )}
          </If>
          <If when={reader.suggestions().length > 0}>
            <SuggestionsCard
              suggestions={reader.suggestions()}
              onAdd={(s) => reader.onAddSuggestion?.(s)}
              onDismiss={(key) => reader.onDismissSuggestion?.(key)}
            />
          </If>
          <If when={reader.painted()} else={<ReaderSkeleton testID="reader-body-skeleton" />}>
            <Body width={bodyWidth()} onLink={onLink} />
          </If>
          <Attachments onOpen={openAttachment} />
        </View>
      </Scroll>
      <Footer />
    </View>
  );
}

export interface ReaderProps {
  /** Set when the reader stands alone in a one-column window (the shell's
   * compact layout): a Back button at its top returns to the list. Escape
   * does the same, through the shell's keys. */
  onBack?: () => void;
}

export function Reader(props: ReaderProps = {}) {
  useReader();
  registerReaderAssistant();
  useEventSuggestions();
  registerCommand("zoomIn", () => readerPrefs.zoomBy(0.1));
  registerCommand("zoomOut", () => readerPrefs.zoomBy(-0.1));
  registerCommand("zoomReset", () => readerPrefs.resetZoom());
  const state = computed<"blank" | "loading" | "error" | "message">(() => {
    if (reader.id() === "") return "blank";
    if (reader.summary()) return "message";
    if (reader.error() !== "") return "error";
    return "loading";
  });
  return (
    <View testID="reader" class="flex-1 bg-background">
      <If when={!!props.onBack && state() !== "blank"}>
        <ActionBar label="Navigation" edge="top" testID="reader-backbar">
          <ToolButton testID="reader-back" label="Back" icon="back" shortcut="esc" onPress={() => props.onBack?.()} />
        </ActionBar>
      </If>
      <If when={state() === "blank"}>
        <BlankSlate />
      </If>
      <If when={state() === "loading"}>
        <View class="flex-1 p-6">
          <ReaderSkeleton testID="reader-skeleton" />
        </View>
      </If>
      <If when={state() === "error"}>
        <EmptyPane
          instant
          testID="reader-error"
          title={reader.error()}
          description="The message may have moved, or the connection dropped."
          icon="error"
          tone="danger"
          actions={<Button label="Try again" onPress={() => reader.retry()} />}
        />
      </If>
      <If when={state() === "message"}>
        <Message />
      </If>
      <ImageViewer />
    </View>
  );
}
