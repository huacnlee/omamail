// The AI dock: a side panel at the window's trailing edge, resizable from
// its leading edge, about one message, a selection or the open draft. Port
// of AssistantDock.qml and AgentPrompt.qml. Keys follow docs/KEYS.md
// ("assistant" and "assistantCommands" contexts).
import {
  LayoutAnimation, List, Text, View, cleanup, createMotion, effect, reduceMotion, signal, windowSize,
} from "nsh";
import { COMMAND_LABELS, commandMatches, historyLabel, historyParts, isActive, progressText, stateLabel, workingParts, detailText, type ChatRow } from "../../mail/agent";
import { app } from "../../app/store";
import { registerCommand, registerEscape, reportKeyState } from "../../keys/commands";
import {
  Button, EmptyPane, Icon, IconButton, ListItem, RADIUS, SPLIT_HIT, SplitHandle, TEXT, Textarea, ToolButton, cx, DURATION, DISTANCE, enterRise,
  KeyHints, LINE, scaled, sizedBox, type KeyHint, type TextareaRef,
} from "../../ui";
import { ChatText } from "./ChatText";
import { host } from "./host";
import { ProposalCard } from "./ProposalCard";
import { agentCapable, contextError, diagnose, runner, startAgent } from "./service";
import { aiSettings, persistAiSettings } from "./settings";
import { assistant, pending } from "./store";

/** The dock's widths for a window `width` wide, as App.qml set them. */
/** The dock's widths for a window `width` wide. Its floor, its default and
 * the room it leaves the mail are base-14 lengths, so they grow with
 * Omarchy's base size (`points`, the ui layer's `scaled`). */
export function dockWidths(width: number, points: (base: number) => number = scaled) {
  const max = Math.max(0, Math.min(width * 0.65, width - points(320)));
  const min = Math.min(points(280), max);
  const preferred = Math.min(points(420), width * 0.45);
  return { min, max, preferred };
}

export function clampDock(stored: number, width: number): number {
  const { min, max, preferred } = dockWidths(width);
  const wanted = stored > 0 ? stored : preferred;
  return Math.round(Math.max(min, Math.min(max, wanted)));
}

function glide() {
  if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(DURATION.normal, "easeInEaseOut", "opacity"));
}

/** Asks about what the owner is looking at: the draft, the ticked rows or the open message. */
export function askAboutCurrent() {
  if (app.composing()) {
    if (assistant.open() && assistant.target()?.kind === "draft") return assistant.show();
    glide();
    return assistant.openForDraft();
  }
  const checked = app.checked();
  if (checked.length > 1) {
    glide();
    return assistant.openForSelection(checked, app.accountId());
  }
  const id = app.selectedId();
  if (id === "") return;
  const summary = host().summary(app.accountId(), id);
  glide();
  assistant.openFor(id, String((summary && (summary as any).subject) || ""), app.accountId());
}

/** "Sending · ", "Paused · " or "Pending · ": where a queued follow-up is. */
function pendingPrefix(index: number): string {
  pending.version();
  return pending.dispatching && index === 0 ? "Sending · " : pending.paused ? "Paused · " : "Pending · ";
}

function Row(props: { row: ChatRow; jobId: string }) {
  const proposal = () => (props.row.role === "proposal" ? assistant.proposals().find((p) => String(p.id) === props.row.text) ?? null : null);
  return (
    <View class="px-4 py-2">
      <If when={props.row.role === "user"}>
        <View testID="agent-user-message" class={cx(RADIUS, "flex-row items-start gap-2 bg-surface-raised px-3 py-2")}>
          <View class={cx(sizedBox("h-6", "h", 24), "justify-center")}>
            <Icon name="chevronRight" size={14} class={TEXT.secondary} />
          </View>
          <View selectable class="flex-1">
            <Text class={TEXT.message}>{props.row.text}</Text>
          </View>
        </View>
      </If>
      <If when={props.row.role === "assistant"}>
        <ChatText text={props.row.text} />
      </If>
      <If when={props.row.role === "status"}>
        <Text class={TEXT.caption}>{props.row.text}</Text>
      </If>
      <If when={proposal()}>{(p) => <ProposalCard proposal={p()} jobId={props.jobId} />}</If>
    </View>
  );
}

export function AssistantDock() {
  persistAiSettings();
  startAgent();
  const stopPolls = runner.run();
  cleanup(stopPolls);

  // The AI selection comes from Settings → AI; a change starts fresh chats.
  let revision = -1;
  effect(() => runner.setSelection(aiSettings.agent(), aiSettings.model(), aiSettings.chatResetAt()));
  effect(() => {
    const next = runner.selectionRevision();
    if (revision >= 0 && next !== revision) assistant.selectionChanged();
    revision = next;
  });
  effect(() => runner.setAccount(app.unified() ? "" : app.accountId()));
  runner.onFailed = (text) => app.setNotice(text);

  const tick = setInterval(() => assistant.tick(), 200);
  cleanup(() => clearInterval(tick));
  const now = signal(Date.now());
  const preparing = signal(Date.now());
  const clock = setInterval(() => {
    if (assistant.open() && assistant.working()) now.set(Date.now());
  }, 1000);
  cleanup(() => clearInterval(clock));
  let wasWorking = false;
  effect(() => {
    const working = assistant.working();
    if (working && !wasWorking) preparing.set(Date.now());
    wasWorking = working;
  });
  effect(() => assistant.watchJob());

  const width = () => clampDock(aiSettings.dockWidth(), windowSize().width);
  let field: TextareaRef | null = null;
  effect(() => {
    assistant.focusTick();
    if (assistant.open() && !assistant.historyMode()) setTimeout(() => field?.focus(), 0);
  });

  // Focus anywhere in the dock (the input, a card's field, a button).
  const within = signal(false);
  const editing = signal(false);
  const commandIndex = signal(0);
  const dismissed = signal("");
  const matches = () => commandMatches(assistant.input());
  const commandsOpen = () =>
    assistant.open() && !assistant.historyMode() && editing() && assistant.input() !== dismissed() && matches().length > 0;
  effect(() => {
    matches();
    commandIndex.set(0);
  });

  const chooseCommand = (index: number) => {
    const command = matches()[index];
    if (!command) return;
    if (assistant.input().trim() === command || command === "/history") {
      assistant.setInput(command);
      void assistant.submit();
      return;
    }
    assistant.setInput(command + " ");
    dismissed.set(command + " ");
    field?.focus();
  };

  // Keys go through the shell's table (docs/NSH-PORT.md "Keys and commands").
  registerCommand("askAgent", () => askAboutCurrent());
  registerCommand("assistantSend", () => void assistant.submit());
  registerCommand("assistantChooseCommand", () => chooseCommand(commandIndex()));
  registerCommand("assistantCommandNext", () => {
    const n = matches().length;
    if (n > 0) commandIndex.set((commandIndex() + 1) % n);
  });
  registerCommand("assistantCommandPrevious", () => {
    const n = matches().length;
    if (n > 0) commandIndex.set((commandIndex() - 1 + n) % n);
  });
  // "Diagnose with AI..." on the status line, while this build runs agents.
  // Registered inside the effect: it goes when the capability does.
  effect(() => {
    if (agentCapable() === true) registerCommand("diagnoseError", () => void diagnose().then((text) => app.setNotice(text)));
  });

  // Escape: commands, then history, then a running request, then the dock.
  registerEscape(() => {
    if (!assistant.open() || !within()) return false;
    if (commandsOpen()) {
      dismissed.set(assistant.input());
      return true;
    }
    if (assistant.historyMode()) {
      assistant.leaveHistory();
      return true;
    }
    if (assistant.interrupt()) return true;
    glide();
    assistant.close();
    return true;
  });
  reportKeyState(() => ({
    assistantEditing: assistant.open() && editing(),
    assistantCommands: commandsOpen(),
    hasAgent: agentCapable() !== false,
    assistantWidth: assistant.open() ? width() + SPLIT_HIT : 0,
  }));

  const status = () => {
    const job = assistant.job();
    const queueError = pending.version() >= 0 && pending.visibleHere ? pending.error : "";
    if (assistant.errorText()) return assistant.errorText();
    if (queueError) return queueError;
    // Working draws its own line (the time in mono, Esc as a key cap); this
    // is the progress note under it.
    if (assistant.working()) return progressText(job);
    if (job && !runner.canContinueSelection(job)) return "Read-only chat from a previous AI selection. Start a new chat to continue.";
    return job ? stateLabel(job) : "Ask your system AI about this mail.";
  };

  const headerMotion = createMotion();
  const statusMotion = createMotion();
  const working = () => (assistant.working() && assistant.errorText() === "" ? workingParts(assistant.job(), now(), preparing()) : null);
  // The keys useful in the input: one keymap with the commands registered above.
  const hints = (): KeyHint[] => [
    { key: "enter", label: "send" },
    { key: "/", label: "commands" },
    { key: "esc", label: isActive(assistant.job()) ? "interrupt" : "close" },
  ];
  effect(() => {
    // A changed status line rises in rather than replacing its text in place.
    status();
    working()?.label;
    if (!reduceMotion()) statusMotion.play(enterRise(DISTANCE.popup));
  });

  return (
    <If when={assistant.open()}>
      <View class="h-full flex-row">
      <SplitHandle
        testID="assistant-width"
        label="AI panel width"
        line="end"
        grow={-1}
        size={width()}
        min={dockWidths(windowSize().width).min}
        max={dockWidths(windowSize().width).max}
        defaultSize={dockWidths(windowSize().width).preferred}
        onResize={(next) => aiSettings.setDockWidth(Math.round(next))}
        onReset={() => aiSettings.setDockWidth(0)}
      />
      <View
        testID="assistant-dock"
        class="h-full bg-muted"
        style={{ width: width() }}
        accessibilityLabel="AI"
        onFocusIn={() => within.set(true)}
        onFocusOut={() => within.set(false)}
      >
        <If
          when={agentCapable() !== false}
          else={
            <EmptyPane
              icon="agent"
              title="AI is not available here"
              description="This build of Omamail runs no AI agents. AI needs the desktop app on macOS or Linux."
            />
          }
        >
          {/* Header */}
          <View style={headerMotion.style} class={cx(sizedBox("h-11", "h", 44), "flex-row items-center gap-2 px-4 border-b", LINE.divider)}>
            <If when={assistant.historyMode()}>
              <ToolButton testID="agent-history-back" icon="back" label="Chat" onPress={() => assistant.leaveHistory()} />
            </If>
            <Icon name="agent" size={16} class={TEXT.secondary} />
            <Text class={cx(TEXT.title, "line-clamp-1 flex-1")}>{assistant.title()}</Text>
            <If when={!assistant.historyMode()}>
              <ToolButton icon="clock" iconOnly label="History..." onPress={() => assistant.showHistory()} />
            </If>
            <ToolButton
              icon="close"
              iconOnly
              label="Close AI"
              shortcut="Esc"
              onPress={() => {
                glide();
                assistant.close();
              }}
            />
          </View>

          {/* History */}
          <If when={assistant.historyMode()}>
            <View class="flex-1">
              <If when={!runner.listingAtStart || runner.hasMoreJobs()}>
                <View class="flex-row gap-2 px-4 py-3">
                  <If when={!runner.listingAtStart}>
                    <Button size="small" label="Newer chats" onPress={() => runner.pageChats(false)} />
                  </If>
                  <If when={runner.hasMoreJobs()}>
                    <Button size="small" label="Older chats" onPress={() => runner.pageChats(true)} />
                  </If>
                </View>
              </If>
              <List
                class="flex-1"
                each={assistant.historyJobs()}
                keyExtractor={(job) => String(job.id)}
                estimatedItemSize={32}
                empty={<EmptyPane layout="inline" title="No conversations for this mail yet." />}
              >
                {(job) => (
                  <ListItem
                    selected={String(job().id) === String(assistant.job()?.id ?? "")}
                    accessibilityLabel={historyLabel(job())}
                    onPress={() => assistant.selectHistory(String(job().id))}
                  >
                    <View class="flex-row items-center gap-3">
                      <Text class={cx(TEXT.body, "line-clamp-1 flex-1")}>{historyParts(job()).title}</Text>
                      <Text class={cx(TEXT.caption, TEXT.mono)}>{historyParts(job()).time}</Text>
                    </View>
                  </ListItem>
                )}
              </List>
            </View>
          </If>

          {/* Chat */}
          <If when={!assistant.historyMode()}>
            <View class="flex-1">
              <List
                class="flex-1"
                testID="agent-transcript-scroll"
                each={assistant.rows()}
                keyExtractor={(row, index) => (row.role === "proposal" ? "p:" + row.text : index + ":" + row.role)}
                estimatedItemSize={48}
                initialScrollAtEnd
                maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 48 }}
                onLoadMoreAtStart={() => runner.loadEarlier()}
                header={
                  <If when={runner.previousPage() !== ""}>
                    <View class="items-center py-2">
                      <Button size="small" variant="ghost" label="Earlier messages" loading={runner.loadingEarlier()} onPress={() => runner.loadEarlier()} />
                    </View>
                  </If>
                }
                empty={
                  <EmptyPane
                    layout="inline"
                    icon="sparkles"
                    title={assistant.available() ? "Ask about this mail" : runner.availabilityError()}
                    description={assistant.available() ? "Summaries, replies and questions stay in this panel until you send them." : undefined}
                  />
                }
              >
                {(row) => <Row row={row()} jobId={String(assistant.job()?.id ?? "")} />}
              </List>

              <If when={!!assistant.job() && detailText(assistant.job()) !== ""}>
                <Text class={cx(TEXT.caption, "px-4 pb-1")}>{detailText(assistant.job())}</Text>
              </If>

              <View class="flex-row flex-wrap gap-2 px-4">
                <If when={!!assistant.job() && !assistant.canContinue() && !assistant.working()}>
                  <Button size="small" label="New chat" disabled={pending.version() >= 0 && pending.busy} onPress={() => assistant.newChat(true)} />
                </If>
                <If when={assistant.draftAnswer() !== "" && runner.apiVersion() < 6}>
                  <Button size="small" label="Insert at cursor" onPress={() => host().composer.insertAtCursor?.(assistant.draftAnswer())} />
                  <Button size="small" label="Replace body" onPress={() => host().composer.replaceBody?.(assistant.draftAnswer())} />
                </If>
              </View>

              {/* Pending follow-ups */}
              <If when={pending.version() >= 0 && pending.busy && pending.visibleHere}>
                <View class="gap-1 px-4 pt-2">
                  <Each of={pending.version() >= 0 ? pending.messages : []} key="index">
                    {(text, index) => (
                      <View class="flex-row items-center gap-1">
                        <View class="flex-1">
                          <ListItem accessibilityLabel="Edit pending message" onPress={() => assistant.editPending(index())}>
                            <Text class={cx(TEXT.caption, "line-clamp-2")}>
                              {pendingPrefix(index()) + text()}
                            </Text>
                          </ListItem>
                        </View>
                        <IconButton icon="x" size="small" label="Remove pending message" onPress={() => assistant.removePending(index())} />
                      </View>
                    )}
                  </Each>
                </View>
              </If>

              {/* Status */}
              <View style={statusMotion.style} class="gap-1 px-4 pt-3" accessibilityLiveRegion="polite">
                <If when={working()}>
                  {(w) => (
                    <View testID="agent-chat-working" class="flex-row items-center gap-2">
                      <Text class={TEXT.caption}>{w().label}</Text>
                      <Text class={cx(TEXT.caption, TEXT.mono)}>{w().duration}</Text>
                    </View>
                  )}
                </If>
                <If when={status() !== ""}>
                  <Text testID="agent-chat-status" class={cx(TEXT.caption, assistant.errorText() !== "" && TEXT.danger)}>
                    {assistant.errorText() !== "" ? "Error: " + status() : status()}
                  </Text>
                </If>
              </View>

              {/* Commands */}
              <If when={commandsOpen()}>
                <View class={cx(RADIUS, "mx-4 mt-2 border border-border bg-surface p-1")} role="menu">
                  <Each of={matches()}>
                    {(command, index) => (
                      <ListItem selected={index() === commandIndex()} accessibilityLabel={COMMAND_LABELS[command()]} onPress={() => {
                        assistant.setInput(command());
                        void assistant.submit();
                      }}>
                        <View class="flex-row items-center gap-3">
                          <Text class={cx(TEXT.body, TEXT.mono)}>{command()}</Text>
                          <Text class={cx(TEXT.caption, "flex-1 line-clamp-1")}>{COMMAND_LABELS[command()]}</Text>
                        </View>
                      </ListItem>
                    )}
                  </Each>
                </View>
              </If>

              {/* Input */}
              <View
                class="gap-2 px-4 pb-3 pt-3"
                onFocusIn={() => editing.set(true)}
                onFocusOut={() => editing.set(false)}
              >
                <View class="flex-row items-end gap-2">
                <View class="flex-1">
                  <Textarea
                    ref={(r) => (field = r)}
                    rows={2}
                    accessibilityLabel="Message AI"
                    placeholder={assistant.job() ? "Message AI" : "Ask about this mail"}
                    value={assistant.input()}
                    onChange={(e) => assistant.setInput(e.value)}
                  />
                </View>
                <If
                  when={isActive(assistant.job())}
                  else={
                    <ToolButton
                      icon="send"
                      iconOnly
                      size="medium"
                      label="Send"
                      shortcut="Enter"
                      disabled={assistant.input().trim() === ""}
                      onPress={() => void assistant.submit()}
                    />
                  }
                >
                  <ToolButton icon="stop" iconOnly size="medium" label="Stop request" shortcut="Esc" onPress={() => assistant.interrupt()} />
                </If>
                </View>
                <KeyHints testID="agent-key-hints" hints={hints()} />
              </View>
            </View>
          </If>
        </If>
      </View>
      </View>
    </If>
  );
}

// Kept for tests: the context error is the dock's to show.
export { contextError };
