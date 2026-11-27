// Every app-owned control of the ui layer, in each of its states, on one
// scrolling page: the place to look at a change to the layer in light and
// dark before it reaches a screen. `nsh run src/ui/GalleryApp.tsx` opens it.
//
// The page is the ui layer's own: it composes only what src/ui exports.
import { signal, Text, View, Scroll, type JSX, type ViewRef } from "nsh";
import {
  ActionBar,
  ActionBarGroup,
  ActionBarSeparator,
  ActionBarSpacer,
  Button,
  ChipInput,
  ChoiceDialog,
  ControlledContextMenu,
  ContextMenuArea,
  CountBadge,
  EmptyPane,
  InitialAvatar,
  Kbd,
  KeyHints,
  ListRow,
  ListSkeleton,
  PickerRow,
  LoadingRow,
  MenuButton,
  MenuItem,
  MenuSeparator,
  NavRow,
  NavList,
  Notice,
  NoticeStack,
  Omarchy,
  ReaderSkeleton,
  SectionHeading,
  SegmentedControl,
  Spinner,
  SplitPane,
  SplitPanel,
  SplitHandle,
  TextEditor,
  ToolButton,
  UnreadDot,
  confirmAction,
  type ChipToken,
  type NoticeItem,
  BASE_SIZE,
  Field,
  Select,
  Popover,
  ScrollBox,
  Input,
  Checkbox,
  Icon,
  Switch,
  Stepper,
  Titled,
  StatusPill,
  Tabs,
  Tab,
  SettingSection,
  SettingRow,
  Hint,
  Disclosure,
  OverlayPanel,
  ShortcutTooltip,
  setOmarchyFont,
  setThemeMode,
  themeMode,
  type ThemeMode,
  useRovingFocus,
} from "./index";
import { LINE, TEXT, cx } from "./tokens";

function Section(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-2 border-b border-border pb-4">
      <SectionHeading label={props.title} inset="flush" />
      {props.children}
    </View>
  );
}

function Caption(props: { children?: JSX.Element }) {
  return <Text class={TEXT.caption}>{props.children}</Text>;
}

export function Gallery() {
  const density = signal<"compact" | "comfortable">("compact");
  const view = signal<"original" | "plain">("original");
  const loadingImages = signal(false);
  const navSelected = signal("inbox");
  // A tree with roving focus: Clients folds; "Projects" names no label (opens nothing).
  const treeSelected = signal("inbox");
  const clientsOpen = signal(true);
  const treeTargets = () => [
    { key: "inbox", opens: true, depth: 0, folds: false, expanded: false },
    { key: "clients", opens: true, depth: 0, folds: true, expanded: clientsOpen() },
    ...(clientsOpen()
      ? [
          { key: "contoso", opens: true, depth: 1, folds: false, expanded: false },
          { key: "projects", opens: false, depth: 1, folds: false, expanded: false },
        ]
      : []),
    { key: "travel", opens: true, depth: 0, folds: false, expanded: false },
  ];
  let treeInbox: ViewRef | undefined;
  let laneEmpty: ViewRef | undefined;
  const laneDone = signal("none");
  const tree = useRovingFocus({
    targets: treeTargets,
    selectedKey: treeSelected,
    open: (t) => treeSelected.set(t.key),
    fold: (_t, expanded) => clientsOpen.set(expanded),
  });
  const rowSelected = signal("r2");
  const starred = signal(false);
  const draft = signal("");
  const recipients = signal<ChipToken[]>([
    { id: "1", label: "Ada Lovelace", detail: "ada@example.com" },
    { id: "2", label: "not-an-address", invalid: true },
  ]);
  const splitSizes = signal<number[]>([200]);
  const dockWidth = signal(240);
  const pickerCursor = signal("work");
  const body = signal("");
  const pickerChosen = signal("");
  const notices = signal<NoticeItem[]>([
    {
      id: "images",
      text: "Remote images are hidden to protect your privacy.",
      secondaryAction: { label: "Show images", onPress: () => {} },
      action: { label: "Always show", onPress: () => {} },
    },
    { id: "dir", text: "Shown left to right; the message did not say which way it reads.", tone: "info" },
  ]);
  const answer = signal("");
  const pressInfo = signal("");
  const hovered = signal("");
  const rowMenuOpen = signal(false);
  const choiceOpen = signal(false);
  let next = 3;

  let row1: ViewRef | undefined;
  const panelOpen = signal(false);
  const panelOffset = signal(0);
  const themeChoice = signal<string | null>(null);
  const advancedOpen = signal(false);
  const baseSize = signal(BASE_SIZE);
  const stepped = signal(14);
  let navInbox: ViewRef | undefined;
  return (
    <Scroll testID="gallery" class="flex-1 bg-background">
      <View class="gap-4 p-4">
        <View class="flex-row items-center gap-3">
          <Text class={TEXT.title}>ui layer</Text>
          <View class="flex-1" />
          <SegmentedControl
            testID="theme"
            label="Theme"
            value={themeMode()}
            options={[
              { value: "dark", label: "Ink" },
              { value: "light", label: "Paper" },
              { value: "omarchy", label: "Omarchy" },
            ]}
            onChange={(v) => setThemeMode(v as ThemeMode)}
          />
          <SegmentedControl
            testID="base-size"
            label="Base size"
            value={String(baseSize())}
            options={[
              { value: "12", label: "12" },
              { value: "14", label: "14" },
              { value: "16", label: "16" },
            ]}
            onChange={(v) => {
              baseSize.set(Number(v));
              setOmarchyFont({ family: null, baseSize: Number(v) });
            }}
          />
        </View>

        <Section title="Controls">
          <View class={cx("flex-row flex-wrap items-center gap-2")}>
            <Button testID="v2-primary" label="Send" variant="primary" />
            <Button testID="v2-default" label="Save draft" />
            <Button testID="v2-ghost" label="Discard" variant="ghost" />
            <Button testID="v2-danger" label="Remove account..." variant="danger" />
            <Button testID="v2-small" label="Small" size="small" />
            <Button testID="v2-disabled" label="Disabled" disabled />
          </View>
          <View class={cx("flex-row flex-wrap items-center gap-3")}>
            <Checkbox testID="v2-check" label="Checked" checked />
            <Checkbox testID="v2-uncheck" label="Unchecked" checked={false} />
            <Switch testID="v2-switch" label="Switch (drawn as a box)" />
            <Stepper
              testID="v2-stepper"
              name="Font size"
              value={`${stepped()} pt`}
              onStep={(d) => stepped.update((n) => Math.min(24, Math.max(10, n + d)))}
            />
          </View>
          <View class={cx("flex-row flex-wrap items-center gap-3")}>
            <Tabs testID="v2-tabs" variant="segmented" accessibilityLabel="Layout">
              <Tab value="split" label="Split" />
              <Tab value="list" label="List" />
              <Tab value="reader" label="Reader" />
            </Tabs>
            <Tabs testID="v2-tabs-line" accessibilityLabel="Section">
              <Tab value="general" label="General" />
              <Tab value="accounts" label="Accounts" />
            </Tabs>
            <StatusPill testID="v2-pill" label="INBOX" />
            <StatusPill label="OFFLINE" tone="danger" />
            <Kbd testID="v2-kbd" keys="mod-k" />
          </View>
          <Titled testID="v2-titled" title="Account" bodyClass={cx("p-4 gap-2")}>
            <Text class={TEXT.body}>A panel titled on its top edge.</Text>
            <Text class={TEXT.caption}>Captions are 12pt and muted.</Text>
          </Titled>
        </Section>

        <Section title="Notice">
          <Notice testID="notice-plain" text="This message is shown as plain text." />
          <Notice
            testID="notice-busy"
            tone="info"
            text="Remote images are hidden."
            action={{
              label: "Show images",
              busyLabel: "Loading images...",
              busy: loadingImages(),
              onPress: () => {
                loadingImages.set(true);
                setTimeout(() => loadingImages.set(false), 1500);
              },
            }}
          />
          <Notice testID="notice-warning" tone="warning" text="This message failed its sender check." action={{ label: "Details...", onPress: () => {} }} />
          <Notice testID="notice-danger" tone="danger" text="The draft could not be saved. Your text is kept here." action={{ label: "Retry", onPress: () => {} }} />
          <Notice tone="success" text="Unsubscribed. New mail from this list will not arrive." />
          {/* Titled: who it is about on the top hairline. */}
          <Notice
            testID="notice-titled"
            title="Agent"
            tone="warning"
            text="The agent stopped: the account needs signing in again."
            action={{ label: "Sign in...", onPress: () => {} }}
          />
          <Caption>NoticeStack</Caption>
          <NoticeStack testID="stack" items={notices()} />
          <View class="flex-row gap-2">
            <Button
              label="Add notice"
              size="small"
              onPress={() => notices.update((n) => [...n, { id: `n${next}`, text: `Notice ${next++}`, tone: "info" }])}
            />
            <Button label="Remove last" size="small" variant="ghost" onPress={() => notices.update((n) => n.slice(0, -1))} />
          </View>
        </Section>

        <Section title="Rows">
          <NavList
            testID="nav-list"
            accessibilityLabel="Mailboxes"
            class="w-60 gap-px"
            onMove={(step) => {
              const order = ["inbox", "work", "clients"];
              const at = order.indexOf(navSelected());
              const next =
                step === "first" ? 0 : step === "last" ? order.length - 1 : Math.max(0, Math.min(order.length - 1, at + (step === "next" ? 1 : -1)));
              navSelected.set(order[next]);
            }}
          >
            <NavRow testID="nav-inbox" rowRef={(r) => (navInbox = r)} label="Inbox" icon="inbox" selected={navSelected() === "inbox"} onPress={() => navSelected.set("inbox")} />
            <NavRow testID="nav-work" label="Work" icon="label" count={12} selected={navSelected() === "work"} onPress={() => navSelected.set("work")} />
            <NavRow label="Unread label" icon="label" unread count={2} />
            {/* Siblings beside a folded row reserve its chevron slot, so their icons line up. */}
            <NavRow testID="nav-clients" label="Clients" icon="label" depth={1} reserveLeading count={1200} tooltipText="Work/Clients" selected={navSelected() === "clients"} onPress={() => navSelected.set("clients")} />
            <NavRow testID="nav-projects" label="Projects (folder)" icon="folder" dimmed depth={1} reserveLeading />
            <NavRow
              testID="nav-long"
              label="Clients and their long project names"
              icon="folder"
              depth={1}
              count={7}
              leading={<Icon name="chevronDown" size={12} class="text-text-secondary" />}
            />
            {/* A key cap, not a count: while modifiers are held, the key that opens it. */}
            <NavRow testID="nav-archive" label="Archive" icon="archive" slotKey="3" />
            <NavRow label="Drop here" icon="trash" dropActive />
          </NavList>
          <Button testID="focus-nav" label="Focus mailboxes" size="small" onPress={() => navInbox?.focus()} />
          <Button testID="focus-tree" label="Focus folders" size="small" onPress={() => treeInbox?.focus()} />
          <Button testID="focus-lane-row" label="Focus the row below the quick actions" size="small" onPress={() => laneEmpty?.focus()} />
          <NavList testID="tree" accessibilityLabel="Folders" class="w-60 gap-px" roving={tree}>
            <NavRow testID="tree-inbox" rowRef={(r) => (treeInbox = r)} rovingKey="inbox" label="Inbox" icon="inbox" reserveLeading selected={treeSelected() === "inbox"} onPress={() => treeSelected.set("inbox")} />
            <NavRow
              testID="tree-clients"
              rovingKey="clients"
              label="Clients"
              icon="folder"
              selected={treeSelected() === "clients"}
              onPress={() => treeSelected.set("clients")}
              leading={<Icon name={clientsOpen() ? "chevronDown" : "chevronRight"} size={12} class="text-text-secondary" />}
            />
            <If when={clientsOpen()}>
              <NavRow testID="tree-contoso" rovingKey="contoso" label="Contoso" icon="label" depth={1} reserveLeading selected={treeSelected() === "contoso"} onPress={() => treeSelected.set("contoso")} />
              <NavRow testID="tree-projects" rovingKey="projects" label="Projects" icon="folder" depth={1} reserveLeading dimmed />
            </If>
            <NavRow testID="tree-travel" rovingKey="travel" label="Travel" icon="label" reserveLeading selected={treeSelected() === "travel"} onPress={() => treeSelected.set("travel")} />
          </NavList>
          <Text testID="tree-state" class={TEXT.caption}>{`Tree: ${treeSelected()}${clientsOpen() ? "" : " (Clients folded)"}`}</Text>
          <View class="flex-row gap-1">
            <View class="w-9 gap-px">
              <NavRow label="Inbox" icon="inbox" collapsed selected />
              <NavRow label="Work" icon="label" collapsed count={4} />
            </View>
            <Caption>Collapsed rail: count as dot, label in tooltip</Caption>
          </View>
          <View class="w-96 gap-px">
            <ListRow
              testID="row-1"
              rowRef={(r) => (row1 = r)}
              overline="Ada Lovelace"
              time="10:24"
              title="Lunch on Friday?"
              detail="I found a place near the station that does..."
              unread
              selected={rowSelected() === "r1"}
              onPress={(e) => {
                rowSelected.set("r1");
                pressInfo.set(e.modifiers.shift ? "Range" : e.modifiers.control || e.modifiers.platform ? "Toggle" : "Open");
              }}
              onMouseEnter={() => hovered.set("r1")}
              onMouseLeave={() => hovered.set("")}
            />
            <ContextMenuArea
              menu={
                <>
                  <MenuItem label="Archive" shortcut="e" />
                  <MenuItem label="Mark as unread" shortcut="u" />
                  <MenuSeparator />
                  <MenuItem label="Delete" icon="trash" danger />
                </>
              }
            >
              {(open) => (
                <ListRow
                  testID="row-2"
                  overline="Charles Babbage"
                  threadCount={3}
                  time="Yesterday"
                  title="Re: The engine drawings"
                  detail="Right-click for the menu; the row stays selected while it is open."
                  selected={rowSelected() === "r2" || open()}
                  onPress={() => rowSelected.set("r2")}
                  quickActions={[
                    {
                      name: "star",
                      label: starred() ? "Unstar" : "Star",
                      icon: "star",
                      selected: starred(),
                      shortcut: "s",
                      onPerform: () => starred.update((x) => !x),
                    },
                  ]}
                />
              )}
            </ContextMenuArea>
            <ControlledContextMenu
              testID="row-3-menu"
              open={rowMenuOpen()}
              onOpenChange={(open) => rowMenuOpen.set(open)}
              menu={
                <>
                  <MenuItem label="Archive" shortcut="e" />
                  <MenuItem label="Close menu" onSelect={() => rowMenuOpen.set(false)} />
                </>
              }
            >
              {/* No quick actions on purpose: its actions are in its menu. */}
              <ListRow
                testID="row-3"
                role="row"
                overline="Grace Hopper"
                time="Mon"
                title="Controlled menu and cursor bar"
                detail="The caller opens and closes this row's menu."
                cursor={rowSelected() !== "r3"}
                selected={rowSelected() === "r3" || rowMenuOpen()}
                onPress={() => rowSelected.set("r3")}
              />
            </ControlledContextMenu>
          </View>
          <View class="w-96">
            <ListRow
              testID="row-lane"
              overline="Mary Somerville"
              time="09:12"
              timeTooltip={<ShortcutTooltip label="Thursday 27 November 2026, 09:12" />}
              title="Quick actions over the time on hover"
              threadCount={3}
              fixedHeight
              flush
              selected={rowSelected() === "r4"}
              onPress={() => rowSelected.set("r4")}
              quickActions={[
                { name: "archive", label: "Archive", icon: "archive", shortcut: "e", onPerform: () => laneDone.set("archived") },
                {
                  name: "star",
                  label: starred() ? "Unstar" : "Star",
                  icon: "star",
                  selected: starred(),
                  shortcut: "s",
                  onPerform: () => starred.update((x) => !x),
                },
              ]}
            />
            <Text testID="lane-done" class={TEXT.caption}>{`Lane: ${laneDone()}`}</Text>
            <ListRow
              testID="row-lane-empty"
              rowRef={(r) => (laneEmpty = r)}
              overline="Caroline Herschel"
              time="08:40"
              title="No actions: the time ends on the edge"
              detail="Same text start as the row above."
              fixedHeight
              flush
              selected={rowSelected() === "r5"}
              onPress={() => rowSelected.set("r5")}
            />
          </View>
          <View class="flex-row gap-2">
            <Button label="Open row menu" size="small" onPress={() => rowMenuOpen.set(true)} />
            <Button label="Focus first row" size="small" onPress={() => row1?.focus()} />
            <Caption>Press: {pressInfo() || "none"} · Hover: {hovered() || "none"}</Caption>
          </View>
        </Section>

        <Section title="Settings">
          <View class="w-96">
            <SettingSection title="Reading">
              <SettingRow title="Mark as read" description="After the message has been open for two seconds.">
                <Button label="Change..." size="small" />
              </SettingRow>
              <SettingRow title="Signature" stacked>
                <Input testID="sig" placeholder="Sent with Omamail..." />
              </SettingRow>
              <Checkbox testID="cb" label="Load remote images" checked={false} />
              <Field label="Theme" description="Follows the desktop unless set here." required>
                <Select
                  testID="theme-select"
                  placeholder="Choose a theme"
                  value={themeChoice()}
                  onChange={(e) => themeChoice.set(e.value)}
                  items={[
                    { value: "system", label: "Same as the desktop" },
                    { value: "light", label: "Light", group: "Pinned themes" },
                    { value: "dark", label: "Dark", group: "Pinned themes" },
                  ]}
                />
              </Field>
              <Field label="Host" error="Enter a host name.">
                <Input testID="host" placeholder="imap.example.com" />
              </Field>
              <Hint text="Applies to every account." />
              <Hint tone="danger" text="Could not save: the settings file is read-only." />
              <Disclosure testID="advanced" open={advancedOpen()} label="Show advanced settings" openLabel="Hide advanced settings" onToggle={() => advancedOpen.update((o) => !o)}>
                <SettingRow title="Prefetch bodies" description="Downloads message bodies in the background." />
              </Disclosure>
            </SettingSection>
          </View>
        </Section>

        <Section title="Popover, ScrollBox">
          <View class="flex-row gap-4 items-start">
            <Popover testID="pop" title="Contacts" width={260} padded={false} trigger={<Button testID="pop-trigger" label="Pick a contact..." size="small" />}>
              <ScrollBox testID="box-one" maxHeight={120}>
                <PickerRow label="Ada Lovelace" detail="ada@example.com" lead={<InitialAvatar name="Ada" size="small" decorative />} />
              </ScrollBox>
            </Popover>
            <View class="w-64 border border-border">
              <ScrollBox testID="box-many" maxHeight={120}>
                {["Ada", "Charles", "Grace", "Mary", "Caroline", "Emmy", "Hedy"].map((n) => (
                  <PickerRow label={n} />
                ))}
              </ScrollBox>
            </View>
            <View class="w-64 border border-border">
              <ScrollBox testID="box-few" maxHeight={120}>
                <PickerRow label="Only one" />
              </ScrollBox>
            </View>
          </View>
        </Section>

        <Section title="PickerRow">
          <View class="w-72 gap-px">
            <PickerRow testID="pick-inbox" label="Inbox" icon="inbox" selected cursor={pickerCursor() === "inbox"} onPress={(n) => (n === 2 ? pickerChosen.set("inbox") : pickerCursor.set("inbox"))} />
            <PickerRow testID="pick-work" label="Work" icon="label" cursor={pickerCursor() === "work"} onPress={(n) => (n === 2 ? pickerChosen.set("work") : pickerCursor.set("work"))} />
            <PickerRow testID="pick-off" label="Exchange (not in this build)" icon="mail" disabled onPress={() => pickerChosen.set("off")} />
            <PickerRow label="ada@example.com" detail="Sign-in expired" detailDanger lead={<InitialAvatar name="Ada" size="small" decorative />} />
          </View>
          <View class="w-9 items-center">
            <PickerRow testID="pick-rail" label="" accessibilityLabel="ada@example.com" tooltip="ada@example.com" lead={<InitialAvatar name="Ada" size="small" decorative />} />
          </View>
          <Caption>Cursor: {pickerCursor()}{pickerChosen() ? ` · chosen: ${pickerChosen()}` : ""}</Caption>
        </Section>

        <Section title="CountBadge, UnreadDot, Avatar">
          <View class="flex-row items-center gap-4">
            <CountBadge count={7} />
            <CountBadge count={1500} />
            <CountBadge count={42} variant="quiet" />
            <UnreadDot unread />
            <UnreadDot unread size="medium" />
            <UnreadDot unread={false} />
            <InitialAvatar testID="avatar-name" name="Ada Lovelace" />
            <InitialAvatar email="zoe@example.com" size="large" />
            <InitialAvatar />
            <InitialAvatar name="All inboxes" icon="inbox" />
          </View>
        </Section>

        <Section title="Kbd, KeyHints">
          <View class="flex-row items-center gap-3">
            <Kbd keys="j" />
            <Kbd keys={Omarchy.shortcutLabel("mod-k")} />
            <Kbd keys="esc" variant="strong" />
          </View>
          <KeyHints
            testID="hints"
            hints={[
              { key: "j / k", label: "move" },
              { key: "enter", label: "open" },
              { key: "e", label: "archive" },
              { key: "?", label: "all keys" },
            ]}
          />
          {/* Keys-table spelling, one cap per key. */}
          <KeyHints
            testID="hints-per-key"
            caps="perKey"
            hints={[
              { key: "j / k", label: "move" },
              { key: "Ctrl+Enter", label: "send" },
              { key: "g then i", label: "inbox" },
            ]}
          />
        </Section>

        <Section title="ActionBar, ToolButton, MenuButton">
          <ActionBar label="Message actions" edge="top">
            <ActionBarGroup label="Reply">
              <ToolButton testID="tb-reply" label="Reply" icon="reply" shortcut="r" />
              <ToolButton label="Reply all" icon="replyAll" shortcut="a" />
              <ToolButton label="Forward" icon="forward" shortcut="f" />
            </ActionBarGroup>
            <ActionBarSeparator />
            <ToolButton label="Archive" icon="archive" iconOnly shortcut="e" />
            <ToolButton label="Saving" icon="check" loading />
            <ToolButton label="Disabled" icon="clock" disabled />
            <ActionBarSpacer />
            <MenuButton testID="more" label="More actions" accessibilityLabel="More actions for this message..." iconOnly>
              <MenuItem label="Print..." icon="file" shortcut="mod-p" />
              <MenuItem label="Show original..." icon="terminal" />
            </MenuButton>
            <ToolButton testID="open-panel" label="Keyboard shortcuts..." icon="menu" onPress={() => panelOpen.set(true)} />
            <ToolButton testID="close-draft" label="Close draft..." accessibilityLabel="Close draft: Lunch on Friday..." icon="close" onPress={() => choiceOpen.set(true)} />
            <ChoiceDialog
              testID="choice"
              title="Save this draft?"
              description="Discard deletes it; Save keeps it in Drafts."
              open={choiceOpen()}
              choices={[
                { id: "discard", label: "Discard", tone: "danger" },
                { id: "save", label: "Save", tone: "primary" },
              ]}
              onChoose={(id) => {
                answer.set(id === "save" ? "Saved" : "Discarded");
                choiceOpen.set(false);
              }}
              onCancel={() => {
                answer.set("Cancelled");
                choiceOpen.set(false);
              }}
            />
            <ToolButton label="Delete" icon="trash" variant="danger" onPress={() => void confirmAction({ title: "Delete this message forever?", description: "It cannot be recovered.", actionLabel: "Delete forever", destructive: true }).then((ok) => answer.set(ok ? "Deleted" : "Kept"))} />
          </ActionBar>
          {/* Standing alone in content: the outline shows where the button starts. */}
          <View class="flex-row gap-2">
            <ToolButton testID="tb-outline" label="Attachments" icon="attachment" outline />
            <ToolButton testID="tb-ghost" label="Attachments" icon="attachment" />
          </View>
          <If when={answer() !== ""}>
            <Caption>Confirm answered: {answer()}</Caption>
          </If>
        </Section>

        <Section title="SegmentedControl">
          <View testID="seg-bar" class={cx("flex-row items-center gap-2 h-11 border-b border-border")}>
            <Button label="Reply" size="small" />
            <SegmentedControl
              testID="seg-centred"
              label="Show as"
              value={density()}
              options={[
                { value: "compact", label: "Reader" },
                { value: "comfortable", label: "Original" },
              ]}
              onChange={(v) => density.set(v)}
            />
          </View>
          <SegmentedControl
            testID="density"
            label="Density"
            value={density()}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
            onChange={(v) => density.set(v)}
          />
          <Text testID="density-value" class={TEXT.caption}>
            Density: {density()}
          </Text>
          <View class="w-72">
            <SegmentedControl
              label="Message view"
              size="medium"
              width="fill"
              value={view()}
              options={[
                { value: "original", label: "Original", icon: "mail", tooltip: "The sender's layout, with images you allowed" },
                { value: "plain", label: "Plain text", icon: "text", tooltip: "The message's text only, no layout or images" },
              ]}
              onChange={(v) => view.set(v)}
            />
          </View>
        </Section>

        <Section title="ChipInput">
          <View class="w-96 gap-2">
            <ChipInput
              testID="to"
              label="To"
              tokens={recipients()}
              value={draft()}
              placeholder="Add recipients"
              onChange={(v) => draft.set(v)}
              onCommit={(text) => recipients.update((r) => [...r, { id: `t${next++}`, label: text, invalid: !text.includes("@") }])}
              onRemove={(id) => recipients.update((r) => r.filter((t) => t.id !== id))}
            />
            <ChipInput label="Cc" tokens={[]} value="" placeholder="Disabled" disabled onChange={() => {}} onCommit={() => {}} onRemove={() => {}} />
          </View>
        </Section>

        <Section title="TextEditor">
          <View class="w-96">
            <TextEditor testID="editor" label="Message" placeholder="Write your message" value={body()} minHeight={80} onChange={(v) => body.set(v)} />
          </View>
          <Caption>Characters: {body().length}</Caption>
        </Section>

        <Section title="Lines">
          <Caption>Structural dividers (header, status line, split) are a hair on Ink and Paper and the border on Omarchy. Content borders keep the border.</Caption>
          <View testID="lines-window" class={cx("h-44 bg-background", LINE.border)}>
            {/* A 44pt page header: the button follows the row's items-center, no self-center needed. */}
            <View testID="lines-header" class={cx("h-11 flex-row items-center gap-3 px-3 border-b", LINE.divider)}>
              <Button testID="lines-back" size="small" variant="ghost" icon="arrow-left" label="Back" />
              <Text class={TEXT.captionStrong}>Header</Text>
            </View>
            <View class="flex-1 flex-row">
              <View class={cx("w-32 bg-muted p-2 border-r", LINE.divider)}>
                <Caption>Sidebar</Caption>
              </View>
              <View class="flex-1 p-2 gap-2">
                <Caption>Content</Caption>
                <View class={cx("h-7 px-2 justify-center bg-background", LINE.border)}>
                  <Caption>A field keeps its border</Caption>
                </View>
              </View>
            </View>
            <View class={cx("h-6 flex-row items-center px-3 border-t", LINE.divider)}>
              <Caption>Status line</Caption>
            </View>
          </View>
          <View class="flex-row gap-2">
            <View testID="swatch-divider" class={cx("size-6", LINE.dividerFill)} />
            <View testID="swatch-border" class={cx("size-6", LINE.hairline)} />
          </View>
        </Section>

        <Section title="SplitPane">
          <View class="h-32 border border-border">
            <SplitPane
              label="Sidebar width"
              onResize={(sizes) => splitSizes.set(sizes)}
              onReset={() => splitSizes.set([200])}
            >
              <SplitPanel size={splitSizes()[0]} minSize={120} fixed>
                <View class="flex-1 p-2">
                  <Caption>Drag the hairline; double-click resets.</Caption>
                </View>
              </SplitPanel>
              <SplitPanel minSize={160}>
                <View class="flex-1 p-2">
                  <Caption>Sizes: {splitSizes().map((s) => Math.round(s)).join(" / ")}</Caption>
                </View>
              </SplitPanel>
            </SplitPane>
          </View>
        </Section>

        <Section title="SplitHandle">
          <View class="h-32 flex-row border border-border">
            <View class="flex-1 p-2">
              <Caption>Drag, double-click, or focus and use the arrows.</Caption>
            </View>
            <SplitHandle
              testID="dock-handle"
              label="Dock width"
              size={dockWidth()}
              min={160}
              max={480}
              defaultSize={240}
              grow={-1}
              line="end"
              onResize={(w) => dockWidth.set(w)}
            />
            <View style={{ width: dockWidth() }}>
              <View class="h-8 justify-center px-2 border-b border-border">
                <Caption>Dock header (line="end" meets its border)</Caption>
              </View>
              <View class="p-2">
                <Caption>Dock: {dockWidth()}</Caption>
              </View>
            </View>
          </View>
        </Section>

        <Section title="Loading">
          <View class="flex-row items-center gap-3">
            <Spinner label="Working" />
            <LoadingRow testID="loading" label="Searching all mail..." />
          </View>
          <View class="flex-row gap-4">
            <View class="w-72 border border-border">
              <ListSkeleton rows={3} />
            </View>
            <View class="flex-1 border border-border">
              <ReaderSkeleton />
            </View>
          </View>
        </Section>

        <Section title="EmptyPane">
          <View class="flex-row gap-4">
            <View class="h-48 flex-1 border border-border">
              <EmptyPane testID="empty" icon="inbox" title="No messages" description="Mail you archive lands here." />
            </View>
            <View class="h-48 flex-1 border border-border">
              <EmptyPane
                icon="error"
                tone="danger"
                title="Could not load this mailbox"
                description="The server did not answer."
                actions={<Button label="Try again" size="small" />}
              />
            </View>
          </View>
        </Section>

        <Text class={cx(TEXT.caption, "pb-8")}>Reduced motion turns every movement here into an instant change.</Text>
      </View>
      <OverlayPanel
        testID="panel"
        title="Keyboard shortcuts"
        top={0}
        open={panelOpen()}
        onOpenChange={(o) => panelOpen.set(o)}
        onScroll={(e) => panelOffset.set(Math.round(e.offset.y))}
        headerAccessory={<Text class={TEXT.caption}>Offset: {panelOffset()}</Text>}
      >
        <View class={cx("flex-row flex-wrap gap-6")}>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <View class={cx("w-60 gap-1")}>
              <Text class={TEXT.title}>Group {n + 1}</Text>
              <KeyHints hints={[{ key: "j / k", label: "move" }, { key: "enter", label: "open" }, { key: "e", label: "archive" }]} />
            </View>
          ))}
        </View>
        {/* Taller than the window: the arrows, Page Down, Space and End scroll it. */}
        <View class={cx("h-[1200px] justify-end")}>
          <Text class={TEXT.caption}>End of the shortcuts</Text>
        </View>
      </OverlayPanel>
    </Scroll>
  );
}
