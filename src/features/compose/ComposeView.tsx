// The editor: From, the recipient lines, Subject, the body, the reply
// history toggle, the files, and Send. Port of ComposeView.qml with its
// header, field rows and footer. The same view fills the mail window's
// overlay and, on desktops, a window of its own.
//
// What a sender wrote (a quoted reply, a forwarded subject, contact names)
// is shown as plain text; nothing in it can press Send.
import { computed, effect, Image, untracked, platform, Scroll, signal, Text, View, type InputRef, type JSX } from "nsh";
import {
  ActionBar, ActionBarSpacer, Button, ChoiceDialog, cx, scaled, sizedBox, Icon, Input, Notice, Select, ShortcutTooltip,
  Spinner, TextEditor, ToolButton, HEIGHT_PT, KeyHints, CLASS, FILL, LINE, RADIUS, TEXT,
  textInputActive,
} from "../../ui";
import { hasCommand, runCommand } from "../../keys/commands";
import { byId } from "../../keys/keymap";
import { shortcutLabel } from "../../keys/labels";
import * as Draft from "../../mail/compose/draft";
import * as Senders from "../../mail/compose/senders";
import { currentWindow } from "nsh/desktop";
import { ContactsPicker } from "./ContactsPicker";
import { RecipientField } from "./RecipientField";
import {
  attachDropped, attachPasted, cancelLeave, chooseFiles, chooseFrom, compose, discard, removeAttachment,
  requestLeave, retryOriginalAttachments, saveAndLeave, send, setBody, showField, toggleQuote, update,
} from "./store";

export interface ComposeViewProps {
  /** Shown in a window of its own: no "Open in window...". */
  windowed?: boolean;
  /** Move the draft to a window of its own (desktops). */
  onDetach?: () => void;
}

/** Send's chord as this platform writes it, from the shell's keymap. */
const SEND_SHORTCUT = shortcutLabel(byId("send")?.keys.find((k) => /Enter$/.test(k)) ?? "Ctrl+Enter");

export function ComposeView(props: ComposeViewProps) {
  let bodyRef: InputRef | undefined;
  let subjectRef: { focus(): void; blur(): void } | undefined;
  let toRef: InputRef | undefined;
  let ccRef: InputRef | undefined;
  let bccRef: InputRef | undefined;
  let replyToRef: InputRef | undefined;
  // STOPGAP: on macOS, while a text field is first responder, a press inside
  // the hidden title bar's area is lost (only pointer enter and moves reach
  // the content view). Pointing at the header's buttons gives the field's
  // focus up first, so the press that follows lands; the text stays. Same as
  // the main header's releaseSearchFocus. NSH issue draft: docs/NSH-PORT.md,
  // "NSH issue: title-bar presses lost while a field is focused". Remove with
  // compose's stopgap test once NSH delivers the press.
  const releaseFieldFocus = () => {
    if (!textInputActive()) return;
    for (const ref of [toRef, ccRef, bccRef, replyToRef, subjectRef, bodyRef]) ref?.blur();
  };
  const dragging = signal(false);

  // Where the keyboard goes when a draft opens: the body for an answer, else
  // the first empty line (To, then Subject), else the body.
  effect(() => {
    compose.focusRequest();
    // Only a request moves the keyboard; typing in the draft does not.
    const d = untracked(() => compose.draft());
    setTimeout(() => {
      if (Draft.isReply(d.mode) || d.mode === "draft") bodyRef?.focus();
      else if (d.to.trim() === "") toRef?.focus();
      else if (d.subject === "") subjectRef?.focus();
      else bodyRef?.focus();
    }, 0);
  });

  const fromKey = (row: { accountId: string; email: string }) => row.accountId + "\n" + row.email.toLowerCase();
  const fromItems = computed(() =>
    compose.fromRows().map((row) => ({
      value: fromKey(row),
      label: Senders.subtitle(row) !== "" ? `${row.email} · ${Senders.subtitle(row)}` : row.email,
    })),
  );
  const fromValue = computed(() => {
    const d = compose.draft();
    const row = compose.fromRows().find((r) => r.email.toLowerCase() === d.fromEmail.toLowerCase());
    return row ? fromKey(row) : null;
  });

  // The body fills the scroll view down to the footer, as in Qt, and grows
  // past it with its text: its least height is what the viewport leaves after
  // the rest of the content (which does not change with the body's height).
  const viewportH = signal(0);
  const contentH = signal(0);
  const editorH = signal(0);
  const bodyMin = () => {
    const rest = contentH() - editorH();
    return Math.max(scaled(240), viewportH() > 0 && editorH() > 0 ? Math.floor(viewportH() - rest) : 0);
  };

  const win = platform.desktop && !props.windowed ? currentWindow() : null;
  const titleArea = () => win?.titleBar() ?? { height: 0, left: 0, right: 0 };
  // STOPGAP: each header control in a View that releases the field when the
  // pointer enters it (releaseFieldFocus), as the main header's ReleasesSearch.
  const Releases = (p: { children: JSX.Element }) => (
    <View onMouseEnter={() => releaseFieldFocus()} onTouchStartCapture={() => releaseFieldFocus()}>
      {p.children}
    </View>
  );
  const bar = () => (
    <>
        <Releases>
          <ToolButton testID="compose-back" label="Back" icon="back" iconOnly onPress={() => requestLeave()} />
        </Releases>
        <Text class={cx(TEXT.title, "px-1")}>{compose.title()}</Text>
        <ActionBarSpacer />
        <If when={!props.windowed && platform.desktop && !!props.onDetach}>
          <Releases>
            <ToolButton testID="compose-detach" label="Open in window..." icon="window" iconOnly onPress={() => props.onDetach?.()} />
          </Releases>
        </If>
        <If when={hasCommand("askAgent")}>
          <Releases>
            <ToolButton testID="compose-ask-ai" label="Ask AI about this draft..." icon="sparkles" iconOnly onPress={() => runCommand("askAgent")} />
          </Releases>
        </If>
        <Releases>
          <ToolButton testID="compose-discard" label="Discard" icon="trash" iconOnly variant="danger" onPress={() => discard()} />
        </Releases>
        <Releases>
          <View class="justify-center">
            <Button
              testID="compose-send"
              label="Send"
              variant="primary"
              size="medium"
              disabled={!compose.canSend()}
              loading={compose.busy()}
              tooltip={<ShortcutTooltip label={compose.sendBlockedReason() || "Send"} shortcut={SEND_SHORTCUT} />}
              onPress={() => send()}
            />
          </View>
        </Releases>
    </>
  );

  return (
    <View
      testID="compose"
      accessibilityLabel={compose.title()}
      class="flex-1 bg-background"
      onFileDragEnter={() => dragging.set(true)}
      onFileDragLeave={() => dragging.set(false)}
      onFileDrop={(e) => {
        dragging.set(false);
        attachDropped(e.uris, e.files);
      }}
    >
      {/* Inline, the shell hides its header while a draft is open: where the
          window's title bar is hidden this bar takes its place, clear of the
          system's window controls and dragging the window from its
          background. It does not hide the system's bar itself (a window that
          shows one keeps it). */}
      <View desktop={{ windowDrag: true }} style={{ paddingLeft: titleArea().left, paddingRight: titleArea().right }} class="bg-background border-b border-border">
        <ActionBar label="Compose" edge="none" inTitleBar={titleArea().height > 0}>{bar()}</ActionBar>
      </View>

      <If when={compose.recoveryNotice() !== ""}>
        <View class="px-3 pt-2">
          <Notice testID="compose-recovery-notice" tone="warning" icon="warning" text={compose.recoveryNotice()} />
        </View>
      </If>

      <Scroll class="flex-1" keyboardDismissMode="none" onLayout={(e) => viewportH.set(e.bounds.size.height)}>
        <View class={cx("gap-3", sizedBox("px-5", "px", 20), sizedBox("py-4", "py", 16))} onLayout={(e) => contentH.set(e.bounds.size.height)}>
          <FieldRow label="From">
            <Select
              testID="compose-from"
              accessibilityLabel="From"
              placeholder="Choose a From address"
              items={fromItems()}
              value={fromValue()}
              onChange={(e) => {
                const row = compose.fromRows().find((r) => fromKey(r) === e.value);
                if (row) chooseFrom(row);
              }}
            />
          </FieldRow>

          <FieldRow label="To" align="start">
            <View class="flex-1">
              <RecipientField
                testID="compose-to"
                label="To"
                value={compose.draft().to}
                onChange={(to) => update({ to })}
                onSubmitEmpty={() => subjectRef?.focus()}
                autoFocus={untracked(() => compose.draft().to.trim() === "" && !Draft.isReply(compose.draft().mode) && compose.draft().mode !== "draft")}
                inputRef={(ref) => (toRef = ref)}
              />
            </View>
            <If when={!compose.draft().ccVisible}>
              <ToolButton testID="compose-show-cc" label="Cc" onPress={() => showField("cc")} />
            </If>
            <If when={!compose.draft().bccVisible}>
              <ToolButton testID="compose-show-bcc" label="Bcc" onPress={() => showField("bcc")} />
            </If>
            <If when={!compose.draft().replyToVisible}>
              <ToolButton testID="compose-show-reply-to" label="Reply-To" onPress={() => showField("replyTo")} />
            </If>
            <ContactsPicker />
          </FieldRow>
          <If when={compose.draft().ccVisible}>
            <FieldRow label="Cc" align="start">
              <RecipientField testID="compose-cc" label="Cc" value={compose.draft().cc} onChange={(cc) => update({ cc })} inputRef={(ref) => (ccRef = ref)} />
            </FieldRow>
          </If>
          <If when={compose.draft().bccVisible}>
            <FieldRow label="Bcc" align="start">
              <RecipientField testID="compose-bcc" label="Bcc" value={compose.draft().bcc} onChange={(bcc) => update({ bcc })} inputRef={(ref) => (bccRef = ref)} />
            </FieldRow>
          </If>
          <If when={compose.draft().replyToVisible}>
            <FieldRow label="Reply-To" align="start">
              <RecipientField
                testID="compose-reply-to"
                label="Reply-To"
                value={compose.draft().replyTo}
                onChange={(replyTo) => update({ replyTo })}
                inputRef={(ref) => (replyToRef = ref)}
              />
            </FieldRow>
          </If>

          <FieldRow label="Subject">
            <View class="flex-1">
            <Input
              ref={(node) => (subjectRef = node)}
              testID="compose-subject"
              value={compose.draft().subject}
              placeholder="Subject"
              accessibilityLabel="Subject"
              onChange={(e) => update({ subject: e.value })}
              onSubmit={() => bodyRef?.focus()}
            />
            </View>
          </FieldRow>

          <View onLayout={(e) => editorH.set(e.bounds.size.height)}>
          <TextEditor
            testID="compose-body"
            label="Message"
            size="message"
            placeholder="Write your message"
            value={compose.draft().body}
            minHeight={bodyMin()}
            pasteMaxSize={Draft.MAX_ATTACHMENT_BYTES}
            inputRef={(node) => (bodyRef = node)}
            onChange={(value) => setBody(value)}
            onPaste={(e) => {
              if (e.files.length > 0 || e.uris.length > 0 || e.tooLarge.length > 0) attachPasted(e.files, e.uris, e.tooLarge.length);
            }}
          />
          </View>

          <If when={compose.canToggleQuote()}>
            <View class="flex-row">
              <ToolButton
                testID="compose-quote-toggle"
                label={compose.hasQuote() ? "Remove quoted history" : "Add original quoted history"}
                icon={compose.hasQuote() ? "minus" : "plus"}
                onPress={() => toggleQuote()}
              />
            </View>
          </If>

          <ForwardNote />
          <Attachments />
        </View>
      </Scroll>

      <ActionBar testID="compose-footer" label="Message actions" edge="bottom">
        <ToolButton
          testID="compose-attach"
          label="Attach..."
          icon="attachment"
          loading={compose.attaching()}
          onPress={() => void chooseFiles()}
        />
        <ActionBarSpacer />
        <If
          when={compose.sendBlockedReason() === ""}
          else={<Text testID="compose-send-hint" class={cx(TEXT.caption, TEXT.warning)}>{`Send is off: ${compose.sendBlockedReason()}`}</Text>}
        >
          <KeyHints testID="compose-send-hint" hints={[{ key: SEND_SHORTCUT, label: "to send" }]} />
        </If>
      </ActionBar>

      <If when={dragging()}>
        <View
          accessibilityLabel="Drop files to attach"
          class={cx("pointer-events-none absolute inset-2 items-center justify-center gap-2 border-2 border-dashed border-primary bg-background/80", RADIUS)}
        >
          <Icon name="attachment" size={24} class="text-primary" />
          <Text class={TEXT.body}>Drop files to attach</Text>
        </View>
      </If>

      <ExitDialog />
    </View>
  );
}

/** One line of the header: its caption in a fixed column, so every field starts at one edge. */
function FieldRow(props: { label: string; align?: "center" | "start"; children?: JSX.Element }) {
  // A field that grows (a recipient line that wraps) keeps its caption on its
  // first line: the caption is centered in a box one control tall, the
  // controls' own height at this base size.
  return (
    <View class={cx("flex-row gap-2", props.align === "start" ? "items-start" : "items-center")}>
      <View class={cx(sizedBox("w-[56px]", "w", 56), `h-[${Math.round(scaled(HEIGHT_PT.medium))}px]`, "justify-center")}>
        <Text testID={`compose-label-${props.label}`} class={cx(TEXT.caption, "text-right")}>{props.label}</Text>
      </View>
      <View class="flex-1 flex-row items-start gap-1">{props.children}</View>
    </View>
  );
}

/** A forward's originals: loading, how many go, or the failure and Retry. */
function ForwardNote() {
  const d = () => compose.draft();
  const show = () => (d().mode === "forward" || d().mode === "draft") && d().originalAttachments.length > 0;
  return (
    <If when={show()}>
      <View testID="compose-forward-note" class="flex-row items-center gap-2">
        <If when={compose.forwardLoading()}>
          <Spinner size={14} />
          <Text class={TEXT.caption}>Loading original attachments...</Text>
        </If>
        <If when={!compose.forwardLoading() && compose.forwardError() !== ""}>
          <Notice
            tone="danger"
            icon="error"
            text={compose.forwardError()}
            action={{ label: "Retry", onPress: () => retryOriginalAttachments() }}
          />
        </If>
        <If when={!compose.forwardLoading() && compose.forwardError() === "" && d().mode === "forward"}>
          <Icon name="attachment" size={14} class="text-text-secondary" />
          <Text class={TEXT.caption}>
            {`${Draft.formatCount(d().forwardedAttachments.length, "original attachment")} will be forwarded`}
          </Text>
        </If>
      </View>
    </If>
  );
}

function Attachments() {
  return (
    <If when={compose.attachments().length > 0}>
      <View testID="compose-attachments" role="list" accessibilityLabel="Attachments" class="gap-1">
        <Each of={compose.attachments()} key="index">
          {(file, index) => <AttachmentRow file={file()} index={index()} />}
        </Each>
      </View>
    </If>
  );
}

function AttachmentRow(props: { file: Draft.Attachment; index: number }) {
  const isImage = () => /^image\/(png|jpe?g|gif|webp)$/i.test(props.file.mimeType) && !!props.file.data;
  return (
    <View
      testID={`compose-attachment-${props.index}`}
      class={cx("flex-row items-center gap-2 px-3 py-1", RADIUS, LINE.border, FILL.rest)}
    >
      <If when={isImage()}>
        <Image
          src={`data:${props.file.mimeType};base64,${props.file.data}`}
          accessibilityLabel={props.file.filename}
          class={cx("size-8 object-cover", RADIUS)}
        />
      </If>
      <If when={!isImage()}>
        <Icon name="file" size={16} class="text-text-secondary" />
      </If>
      <Text class={cx(TEXT.body, "flex-1 line-clamp-1")}>{props.file.filename}</Text>
      <Text class={cx(TEXT.caption, TEXT.mono)}>{Draft.formatSize(props.file.size)}</Text>
      <ToolButton
        label={`Remove ${props.file.filename}`}
        icon="close"
        iconOnly
        onPress={() => removeAttachment(props.index)}
      />
    </View>
  );
}

/** Leaving a changed draft: Cancel, Discard or Save draft (the default). */
function ExitDialog() {
  return (
    <ChoiceDialog
      testID="compose-exit"
      open={compose.exitDialogOpen()}
      title="Save this draft?"
      description="You changed this message. Save your changes before leaving?"
      choices={[
        { id: "discard", label: "Discard", tone: "danger" },
        { id: "save", label: "Save draft", tone: "primary" },
      ]}
      onChoose={(id) => (id === "save" ? saveAndLeave() : discard())}
      onCancel={() => cancelLeave()}
    />
  );
}

