// Settings → Calendars (CalendarSettings.qml): which calendars show and in
// what color, connecting a mailbox's calendars or a CalDAV one, the default
// calendar for new events, where a mail-only mailbox saves accepted
// invitations, and reminders. Every change goes through the calendar's one
// controller (calendars.json) or `calendarSettings` (the app's settings);
// nothing here talks to a server itself. Names, addresses and URLs come from
// accounts, providers and calendars.json, so they are drawn as plain text.
import { View, Text, cleanup, computed, signal, untracked } from "nsh";
import { app } from "../../app/store";
import * as Invitations from "../../mail/calendar/invitations";
import * as Sources from "../../mail/calendar/sources";
import type { AccountSummary, CalendarSource } from "../../mail/calendar/types";
import {
  Button, Checkbox, CLASS, Hint, Input, LINE, NumberInput, Select, SettingRow, SettingSection, TEXT, cx, scaled,
} from "../../ui";
import { accountSummaries, BACKEND } from "./controller";
import { toneFor, slots } from "./palette";
import { controller, startCalendar } from "./service";
import { calendarSettings } from "./settings";

type Summary = ReturnType<typeof accountSummaries>[number];

function summaries(): Summary[] {
  return accountSummaries();
}

function discoverable(): Summary[] {
  if (!BACKEND.canDiscover) return [];
  return summaries().filter((account) => account.calendarProvider === "microsoft" || account.calendarProvider === "icloud"
    || (account.calendarProvider === "google" && BACKEND.canGoogle));
}

function providerName(account: Summary): string {
  return account.calendarProvider === "icloud" ? "iCloud" : account.calendarProvider === "google" ? "Google" : "Microsoft";
}

function accountLabel(source: { accountId?: string }): string {
  const found = summaries().find((account) => String(account.id || "") === String(source.accountId || ""));
  return found ? String(found.email || found.label || "") : "";
}

function orphaned(source: CalendarSource): boolean {
  return Sources.orphaned(source, summaries() as AccountSummary[]);
}

/** A hand-added calendar, or one whose mailbox is gone, is removed here; a
 * mailbox's own is refreshed by discovery instead. */
function removable(source: CalendarSource): boolean {
  return (source.kind === "caldav" && source.discovered !== true) || orphaned(source);
}

/** Google names a mailbox's own calendar after its address, which the row
 * above already shows; beside it the calendar is the primary one. */
function displayName(source: CalendarSource): string {
  const name = String(source.name || source.id || "Calendar");
  const account = accountLabel(source);
  return account !== "" && name.toLowerCase() === account.toLowerCase() ? "Primary" : name;
}

function nestedDetail(source: CalendarSource): string {
  const parts: string[] = [];
  if (source.preferred === true) parts.push("Default for new events");
  if (source.readOnly === true) parts.push("Read-only");
  return parts.join(" · ");
}

function sourceDetail(source: CalendarSource): string {
  if (source.kind === "caldav") return String(source.url || "CalDAV");
  const provider = source.kind === "google" ? "Google" : source.kind === "microsoft" ? "Microsoft" : "iCloud";
  const account = accountLabel(source);
  const detail = orphaned(source) ? provider + " · Mailbox removed" : account === "" ? provider + " calendar" : provider + " · " + account;
  return source.readOnly === true ? detail + " · Read-only" : detail;
}

function reminderMode(source: CalendarSource): string {
  return source.remindersEnabled !== true ? "off" : Number(source.reminderMinutes) >= 0 ? "custom" : "google";
}

const REMINDER_MODES = [
  { value: "off", label: "Off" },
  { value: "google", label: "Google event reminders" },
  { value: "custom", label: "Custom timing" },
];

export interface CalendarSettingsProps {
  /** The Google OAuth client setup (Qt's `clientSetupRequested`). Given, the
   * section ends with "Advanced Google setup..."; left out, there is none. */
  onClientSetup?: () => void;
}

/** The settings section. Mount it inside the settings page. */
export function CalendarSettings(props: CalendarSettingsProps = {}) {
  startCalendar();
  const colorEditing = signal("");
  const passwordEditing = signal("");
  const adding = signal(false);
  const setupAccount = signal("");
  const setupError = signal("");
  const setupComplete = signal(false);
  const result = signal<{ ok: boolean; text: string }>({ ok: true, text: "" });
  const draft = { name: signal(""), url: signal(""), username: signal(""), password: signal("") };
  const rowPassword = signal("");

  const busy = () => controller.savingSource() || controller.discoveringCalendars();
  /** Both editors' Cancel: offered unless a save is past its password check. */
  const cancelOffered = () => !controller.savingSource() || controller.sourceCheckPending();
  const cancelPendingSave = () => { if (untracked(controller.savingSource)) controller.cancelSourceSave(); };

  const allSources = computed<CalendarSource[]>(() => {
    const groups = Sources.groupByAccount(controller.availableSources(), summaries() as AccountSummary[]);
    return groups.reduce<CalendarSource[]>((all, group) => all.concat(group.calendars), []);
  });
  const accountCalendars = (id: string) =>
    allSources().filter((source) => String(source.accountId || "") === String(id || "") && !orphaned(source));
  const otherSources = computed(() => allSources().filter((source) => {
    const account = String(source.accountId || "");
    return account === "" || orphaned(source) || !discoverable().some((value) => String(value.id) === account);
  }));
  const writableSources = computed(() => allSources().filter((source) => Sources.writable(source) && !orphaned(source)));
  const defaultChoices = computed(() => Sources.writableGroups(Sources.groupByAccount(
    { ...controller.availableSources(), sources: writableSources() }, summaries() as AccountSummary[],
  )).filter((group) => group.calendars.length > 1));
  const reminderSources = computed(() => allSources().filter((source) => Sources.nativeCalendarFeatures(source) && !orphaned(source)));
  const invitationSources = computed(() => allSources().filter((source) => source.kind === "google" && !source.readOnly && !orphaned(source)));
  const mailOnly = computed(() => summaries().filter((account) => account.provider !== "gmail"));
  const discoveryChoices = computed(() => {
    const choices = controller.discoveryChoices();
    const account = controller.discoveryChoiceAccount();
    return choices ? choices.sources.filter((source) => source.kind === "google" && source.accountId === account) : [];
  });

  const offSaved = controller.signals.calendarSaved.on((ok, error) => {
    if (!ok) { result.set({ ok: false, text: error }); return; }
    // A save can still have something to say, such as that the password was not checked.
    result.set({ ok: true, text: String(error || "") === "" ? "Calendar saved" : "Calendar saved. " + error });
    draft.name.set(""); draft.url.set(""); draft.username.set(""); draft.password.set("");
    rowPassword.set("");
    adding.set(false);
    passwordEditing.set("");
    colorEditing.set("");
  });
  const offDiscovered = controller.signals.discoveryFinished.on((ok, error, count) => {
    setupError.set(ok ? "" : error);
    setupComplete.set(ok);
    result.set({
      ok,
      text: ok ? "Saved " + count + (count === 1 ? " calendar" : " calendars") + ". Choose reminders below, then open your calendar." : "",
    });
  });
  cleanup(() => { offSaved(); offDiscovered(); });

  function discover(account: Summary) {
    result.set({ ok: true, text: "" });
    colorEditing.set("");
    passwordEditing.set("");
    setupAccount.set(String(account.id || ""));
    setupError.set("");
    setupComplete.set(false);
    if (!account.signedIn) { app.openPage("setup"); return; }
    controller.discoverAccountCalendars(account.id);
  }

  function discoverLabel(account: Summary): string {
    if (!account.signedIn) return "Sign in...";
    if (controller.discoveringCalendars() && controller.discoveringAccountId() === String(account.id || "")) return "Finding...";
    const google = account.calendarProvider === "google";
    const base = accountCalendars(account.id).length > 0 ? "Refresh calendars" : google ? "Enable Google Calendar" : "Find calendars";
    return base + (google ? "..." : "");
  }

  function addCalendar() {
    result.set({ ok: true, text: "" });
    controller.addCalDavCalendar({ name: draft.name(), url: draft.url(), username: draft.username() }, draft.password());
  }

  function setInvitationTarget(mailbox: string, next: string) {
    const current = calendarSettings.value().invitationCalendars;
    const targets: Record<string, unknown> = { ...current };
    const source = invitationSources().find((value) => value.id === next);
    if (source) targets[mailbox] = { ...source };
    else delete targets[mailbox];
    calendarSettings.set("invitationCalendars", targets);
  }

  /** One calendar: its color, name and detail, and its actions. */
  function CalendarRow(props: { source: CalendarSource; detail: string }) {
    const id = () => String(props.source.id);
    const name = () => displayName(props.source);
    return (
      <View testID="calendar-source-row">
        {/* A settings row like the rest: the name and its detail on the
            left, the color, its actions and Show on the right. */}
        <SettingRow testID="calendar-source-setting" title={name()} description={props.detail}>
          <View class="flex-row items-center gap-2">
            <View
              testID="calendar-source-color"
              role="button"
              focusable
              accessibilityLabel={"Change color for " + name()}
              tooltip="Color..."
              onPress={() => {
                if (untracked(busy)) return;
                passwordEditing.set("");
                colorEditing.set(untracked(colorEditing) === id() ? "" : id());
              }}
              class={cx("items-center justify-center rounded-(--radius) border border-transparent", CLASS.wash, "hover:bg-surface-raised", LINE.focus,
                colorEditing() === id() ? "bg-selection" : "")}
              style={{ width: scaled(26), height: scaled(26), cursor: "pointer" }}
            >
              <View class={cx("rounded-(--radius)", toneFor(props.source.colorKey).bar)} style={{ width: scaled(12), height: scaled(12) }} />
            </View>
            <If when={props.source.kind === "caldav" && props.source.discovered !== true}>
              <Button size="small" variant="ghost" label="Set password" disabled={busy()}
                onPress={() => { colorEditing.set(""); rowPassword.set(""); passwordEditing.set(id()); }} />
            </If>
            <If when={removable(props.source)}>
              <Button testID="calendar-source-remove" size="small" variant="danger" label="Remove" disabled={busy()}
                onPress={() => controller.removeCalendar(id())} />
            </If>
            <Checkbox
              testID="calendar-source-toggle"
              label=""
              accessibilityLabel={"Show " + name()}
              checked={props.source.enabled !== false}
              disabled={busy()}
              onChange={(e) => controller.setSourceEnabled(id(), e.checked)}
            />
          </View>
        </SettingRow>
        <If when={colorEditing() === id()}>
          <View testID="calendar-color-picker" class="flex-row items-center gap-1.5 pl-2">
            <Text class={TEXT.caption}>Color</Text>
            <Each of={slots()} key={(slot) => slot.key}>
              {(slot) => (
                <View
                  testID={"calendar-color-" + slot().key}
                  role="button"
                  focusable
                  accessibilityLabel={"Use " + slot().label + " for " + name()}
                  onPress={() => { controller.setSourceColor(id(), slot().key); colorEditing.set(""); }}
                  class={cx("items-center justify-center rounded-(--radius) border",
                    slot().key === String(props.source.colorKey || "") ? "border-primary" : "border-transparent",
                    CLASS.wash, "hover:bg-surface-raised", LINE.focus)}
                  style={{ width: scaled(24), height: scaled(24), cursor: "pointer" }}
                >
                  <View class={cx("rounded-(--radius)", toneFor(slot().key).bar)} style={{ width: scaled(10), height: scaled(10) }} />
                </View>
              )}
            </Each>
          </View>
        </If>
        <If when={passwordEditing() === id()}>
          <View class="flex-row items-center gap-1.5 pl-2">
            <View class="flex-1">
              <Input masked placeholder="Password or app password" accessibilityLabel={"Password for " + name()}
                value={rowPassword()} onChange={(e) => rowPassword.set(e.value)}
                onSubmit={() => controller.updateCalendarPassword(props.source, untracked(rowPassword))} />
            </View>
            <Button size="small" label={controller.savingSource() ? "Saving" : "Save"}
              disabled={rowPassword() === "" || busy()}
              onPress={() => controller.updateCalendarPassword(props.source, untracked(rowPassword))} />
            <Button size="small" variant="ghost" label="Cancel" disabled={!cancelOffered()}
              onPress={() => { cancelPendingSave(); rowPassword.set(""); passwordEditing.set(""); }} />
          </View>
        </If>
      </View>
    );
  }

  return (
    <View testID="calendar-settings" class="gap-6">
      <SettingSection title="Calendars">
        <Hint text="Choose which calendars appear and their colors. New events and reminders are set below." />

        <If when={discoverable().length === 0}>
          <View class="items-start gap-2">
            <Hint text={BACKEND.canDiscover ? "Add a Google, Microsoft or iCloud mailbox to connect its calendars."
              : "Update the mail backend to connect account calendars."} />
            <Button label="Add an account..." onPress={() => app.openPage("setup")} />
          </View>
        </If>

        <Each of={discoverable()} key={(account) => String(account.id)}>
          {(account) => {
            const calendars = () => accountCalendars(account().id);
            return (
              <View class="gap-1">
                <SettingRow
                  title={String(account().email || account().label || "")}
                  description={providerName(account()) + " · " + (!account().signedIn ? "Sign in to connect calendars"
                    : calendars().length > 0 ? calendars().length + (calendars().length === 1 ? " calendar" : " calendars")
                      : "Uses this mailbox's sign-in")}
                >
                  <Button
                    testID={"calendar-discover-" + String(account().calendarProvider || "account()")}
                    size="small"
                    label={discoverLabel(account())}
                    loading={controller.discoveringCalendars() && controller.discoveringAccountId() === String(account().id || "")}
                    disabled={busy()}
                    onPress={() => discover(account())}
                  />
                </SettingRow>
                <Each of={calendars()} key={(source) => String(source.id)}>
                  {(source) => <CalendarRow source={source()} detail={nestedDetail(source())} />}
                </Each>
              </View>
            );
          }}
        </Each>

        <If when={setupError() !== ""}>
          <View testID="calendar-setup-recovery" class="gap-2">
            <Hint tone="danger" text={accountLabel({ accountId: setupAccount() }) + ": " + setupError()} />
            <If when={discoverable().some((account) => account.id === setupAccount() && account.calendarProvider === "google")}>
              <Hint text="For Google, enable the Google Calendar API in the same Cloud project as your Gmail client. If access was refused, sign in again and allow calendar access. Your saved calendar choices are kept." />
            </If>
            <View class="flex-row flex-wrap gap-1.5">
              <Button size="small" label="Check again" disabled={busy()}
                onPress={() => controller.discoverAccountCalendars(untracked(setupAccount))} />
              <Button size="small" label="Sign in again..." onPress={() => app.openPage("setup")} />
            </View>
          </View>
        </If>

        <If when={controller.discoveryChoices() !== null}>
          <View testID="calendar-discovery-choices" class="gap-2">
            <Text class={TEXT.body}>Choose calendars to show</Text>
            <Hint text="Start with your Google selection. You can change visibility and reminders independently below. Your primary writable calendar is selected for new events by default." />
            <Each of={discoveryChoices()} key={(source) => String(source.id)}>
              {(source) => (
                <SettingRow title={String(source().name || source().id)} description={source().readOnly === true ? "Read-only" : ""}>
                  <Checkbox testID="calendar-discovered-toggle" label="" accessibilityLabel={"Show " + String(source().name || source().id)}
                    checked={source().enabled === true} onChange={(e) => controller.chooseDiscovered(source().id, e.checked)} />
                </SettingRow>
              )}
            </Each>
            <View class="flex-row gap-2">
              <Button variant="primary" label={controller.savingSource() ? "Saving..." : "Save calendar selection"}
                disabled={controller.savingSource()} onPress={() => controller.confirmDiscovery()} />
              <Button label="Cancel" onPress={() => controller.cancelDiscovery()} />
            </View>
          </View>
        </If>

        <If when={otherSources().length > 0}>
          <View class="gap-1 pt-3">
            <Text class={TEXT.section}>Other calendars</Text>
            <Each of={otherSources()} key={(source) => String(source.id)}>
              {(source) => <CalendarRow source={source()} detail={sourceDetail(source())} />}
            </Each>
          </View>
        </If>

        <If when={!adding()}>
          <View class="items-start py-3">
            <Button testID="calendar-connect-caldav" icon="plus" label="Connect a CalDAV calendar..." disabled={busy()}
              onPress={() => { colorEditing.set(""); passwordEditing.set(""); adding.set(true); }} />
          </View>
        </If>
        <If when={adding()}>
          <View testID="calendar-caldav-form" class="gap-1.5">
            <Input placeholder="Calendar name" accessibilityLabel="Calendar name" value={draft.name()} onChange={(e) => draft.name.set(e.value)} />
            <Input placeholder="CalDAV URL" accessibilityLabel="CalDAV URL" value={draft.url()} onChange={(e) => draft.url.set(e.value)} />
            <Input placeholder="Username" accessibilityLabel="Username" value={draft.username()} onChange={(e) => draft.username.set(e.value)} />
            <Input masked placeholder="Password or app password" accessibilityLabel="Password"
              value={draft.password()} onChange={(e) => draft.password.set(e.value)} onSubmit={addCalendar} />
            <View class="flex-row gap-1.5">
              <Button variant="primary" label={controller.savingSource() ? "Adding" : "Add calendar"} disabled={busy()} onPress={addCalendar} />
              <Button variant="ghost" label="Cancel" disabled={!cancelOffered()}
                onPress={() => { cancelPendingSave(); draft.password.set(""); adding.set(false); }} />
            </View>
          </View>
        </If>

        <If when={result().text !== ""}>
          <Hint testID="calendar-settings-result" tone={result().ok ? "default" : "danger"} text={result().text} />
        </If>

        <SettingRow testID="calendar-unified-view-row" title="Unified calendar view"
          description="Show every account together instead of following the current mailbox.">
          <Checkbox testID="calendar-unified-view" label="" accessibilityLabel="Unified calendar view"
            checked={calendarSettings.unified()} onChange={(e) => calendarSettings.set("unifiedCalendarView", e.checked)} />
        </SettingRow>

        <If when={setupComplete()}>
          <View class="items-start">
            <Button variant="primary" label="Open calendar" onPress={() => app.openPage("calendar")} />
          </View>
        </If>
      </SettingSection>

      <If when={defaultChoices().length > 0}>
        <SettingSection title="New events">
          <Each of={defaultChoices()} key={(group) => group.id}>
            {(group) => (
              <SettingRow title="Default calendar" description={group().accountLabel}>
                <View>
                  <Select
                    testID="calendar-default-picker"
                    accessibilityLabel={"Default calendar for " + group().accountLabel}
                    items={group().calendars.map((source) => ({ value: String(source.id), label: displayName(source) }))}
                    value={String((group().calendars.find((source) => source.preferred) ?? group().calendars[0])?.id ?? "")}
                    disabled={busy()}
                    onChange={(e) => controller.setDefaultCalendar(e.value)}
                  />
                </View>
              </SettingRow>
            )}
          </Each>
        </SettingSection>
      </If>

      <If when={mailOnly().length > 0}>
        <SettingSection testID="invitation-calendar-settings" title="Accepted invitations">
          <Hint text="Save Yes and Maybe replies from a mail-only mailbox to Google Calendar. Replies still use the invited address." />
          <Each of={mailOnly()} key={(account) => String(account.id)}>
            {(account) => {
              const target = () => Invitations.destination(calendarSettings.value(), String(account().id));
              const items = () => {
                const choices = [{ value: "", label: "Don't save to a calendar" }];
                for (const source of invitationSources()) choices.push({ value: source.id, label: displayName(source) + " · " + source.accountId });
                const current = target();
                if (current && !invitationSources().some((source) => source.id === current.id)) {
                  choices.push({ value: current.id, label: "Unavailable calendar — choose another" });
                }
                return choices;
              };
              return (
                <SettingRow
                  title={String(account().email || account().label || account().id)}
                  description={invitationSources().length ? "Save accepted invitations to" : "Connect a writable Google calendar above"}
                >
                  <View>
                    <Select testID="invitation-calendar-picker" accessibilityLabel={"Calendar for invitations to " + String(account().email || account().id)}
                      items={items()} value={target()?.id ?? ""} onChange={(e) => setInvitationTarget(String(account().id), e.value)} />
                  </View>
                </SettingRow>
              );
            }}
          </Each>
        </SettingSection>
      </If>

      <If when={BACKEND.canGoogle && reminderSources().length > 0}>
        <SettingSection title="Reminders">
          <SettingRow testID="calendar-reminders-enabled-row" title="Desktop reminders"
            description="Shown while Omamail is running, even with its window closed. Google calendars only.">
            <Checkbox testID="calendar-reminders-enabled" label="" accessibilityLabel="Desktop reminders"
              checked={calendarSettings.remindersEnabled()} onChange={(e) => calendarSettings.set("calendarRemindersEnabled", e.checked)} />
          </SettingRow>
          <If when={calendarSettings.remindersEnabled()}>
            <SettingRow title="Snooze" description="How long Snooze puts a reminder off.">
              <View>
                <NumberInput testID="calendar-snooze-minutes" accessibilityLabel="Snooze minutes" suffix="min" min={1} max={1440} step={1}
                  value={calendarSettings.snoozeMinutes()}
                  onChange={(e) => { if (e.value !== null) calendarSettings.set("calendarSnoozeMinutes", e.value); }} />
              </View>
            </SettingRow>
            <Each of={reminderSources()} key={(source) => String(source.id)}>
              {(source) => (
                <SettingRow title={displayName(source())}
                  description={accountLabel(source()) + (source().enabled === false ? " · Hidden, still reminds" : "")}>
                  <View class="flex-row items-center gap-1.5">
                    <If when={reminderMode(source()) === "custom"}>
                      <View>
                        <NumberInput testID="calendar-reminder-minutes" accessibilityLabel={"Minutes before, " + displayName(source())}
                          suffix="min" min={0} max={40320} step={5} value={Math.max(0, Number(source().reminderMinutes))}
                          disabled={controller.savingSource()}
                          onChange={(e) => { if (e.value !== null) controller.setReminderPolicy(source().id, true, e.value); }} />
                      </View>
                    </If>
                    <View>
                      <Select testID="calendar-reminder-mode" accessibilityLabel={"Reminders for " + displayName(source())}
                        items={REMINDER_MODES} value={reminderMode(source())} disabled={controller.savingSource()}
                        onChange={(e) => controller.setReminderPolicy(source().id, e.value !== "off",
                          e.value === "google" ? -1 : Number(source().reminderMinutes) >= 0 ? Number(source().reminderMinutes) : 10)} />
                    </View>
                  </View>
                </SettingRow>
              )}
            </Each>
          </If>
        </SettingSection>
      </If>
      <If when={props.onClientSetup}>
        <View class="items-start">
          <Button testID="calendar-client-setup" size="small" variant="ghost" label="Advanced Google setup..."
            onPress={() => props.onClientSetup?.()} />
        </View>
      </If>
    </View>
  );
}
