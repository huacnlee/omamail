// The event editor (CalendarEventComposer.qml) as a sheet at the window's
// right edge, over whatever is open: the calendar, or a message whose
// invitation or suggestion it was filled from. The form is composer.ts; this
// file only lays it out. Nothing is written until Save, Send update or Save
// without email is pressed.
import { Text, View, createMotion, effect, untracked } from "nsh";
import * as Calendar from "../../mail/calendar/calendar";
import {
  AlertDialog, Button, Checkbox, DatePicker, Field, Input, PickerRow, Select, Sheet, Textarea, Titled, ToolButton,
  type InputRef,
  enterRise, cx, TEXT, CLASS, RADIUS, FILL, sizedBox } from "../../ui";
import { composer, registerComposerKeys } from "./service";
import { localTimeZone } from "./time";
import type { ReminderMode } from "./composer";


const AVAILABILITY = [
  { value: "opaque", label: "Busy — blocks this time" },
  { value: "transparent", label: "Free — keeps this time available" },
];
const VISIBILITY = [
  { value: "default", label: "Calendar default" },
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
];

/** The editor, while `eventComposer` is on the history stack. Mount once,
 * app-wide: invitations and suggestions in mail open it too. */
export function EventComposerSurface() {
  return (
    <Sheet
      title={composer.heading()}
      open={composer.opened()}
      placement="right"
      closeLabel="Cancel"
      onOpenChange={(e) => { if (!e.open) composer.close(); }}
      footer={<ComposerFooter />}
    >
      <If when={composer.opened()}>
        <ComposerForm />
      </If>
    </Sheet>
  );
}

function ComposerForm() {
  registerComposerKeys();
  let titleField: InputRef | undefined;
  effect(() => {
    composer.focusRequests();
    untracked(() => setTimeout(() => titleField?.focus(), 0));
  });
  const source = () => composer.chosenSource();
  const allDay = () => composer.allDay.get();
  const range = () => composer.dateRange();
  const others = () => { composer.setGuestsFocused(false); composer.setDescriptionFocused(false); };

  return (
    <View testID="event-composer" class="w-[400px] max-w-full gap-6">
      <View class="gap-3">
      <Field label="Calendar">
        <Select
          testID="event-calendar-selector"
          accessibilityLabel="Calendar"
          placeholder="Choose a calendar"
          disabled={composer.loadingSeries() || composer.transferring() || composer.transferNeedsRefresh()
            || composer.writePending()}
          items={composer.calendarChoices().map((row) => ({
            value: String(row.source.id),
            label: String(row.source.name || row.source.id),
            group: row.groupLabel,
          }))}
          value={composer.selectedSourceId()}
          onChange={(e) => composer.chooseCalendar(e.value)}
        />
      </Field>

      <Field label="Title">
        <Input
          ref={(node) => { titleField = node; }}
          testID="event-title-field"
          placeholder="Event title"
          value={composer.title.get()}
          onChange={(e) => { others(); composer.title.set(e.value); }}
          onSubmit={() => composer.submit("all")}
        />
      </Field>

      <If when={composer.editing() && !!composer.editingEvent()?.recurringEventId && composer.googleWrites()}>
        <View class="flex-row">
          <ToolButton
            label={composer.loadingSeries() ? "Loading series" : "Edit entire series..."}
            icon="repeat"
            loading={composer.loadingSeries()}
            disabled={composer.loadingSeries() || composer.writePending()}
            onPress={() => composer.editSeries()}
          />
        </View>
      </If>

      </View>

      {/* When: the dates, the times and how it repeats. */}
      <Titled title="When" bodyClass="gap-3 px-3 pt-4 pb-3">
      <Checkbox label="All day" checked={allDay()} onChange={(e) => composer.allDay.set(e.checked)} />

      <Field label="Starts">
        <View class="flex-row gap-2">
          <View class="flex-1 min-w-0">
            <DatePicker
              testID="event-start-date-field"
              accessibilityLabel={allDay() ? "First day" : "Start date"}
              value={composer.date.get()}
              onChange={(e) => composer.editStart(e.value, composer.start.get())}
            />
          </View>
          <If when={!allDay()}>
            <View class={cx(sizedBox("w-[68px]", "w", 68), "shrink-0")}>
              <Input testID="event-start-time-field" placeholder="Start" accessibilityLabel="Start time"
                value={composer.start.get()} onChange={(e) => { others(); composer.editStart(composer.date.get(), e.value); }} />
            </View>
          </If>
        </View>
      </Field>

      <Field label={allDay() ? "Last day" : "Ends"} error={range().ok ? null : range().error}>
        <View class="flex-row gap-2">
          <View class="flex-1 min-w-0">
            <DatePicker
              testID="event-end-date-field"
              accessibilityLabel={allDay() ? "Last day" : "End date"}
              value={composer.endDate.get()}
              onChange={(e) => composer.endDate.set(e.value)}
            />
          </View>
          <If when={!allDay()}>
            <View class={cx(sizedBox("w-[68px]", "w", 68), "shrink-0")}>
              <Input testID="event-end-time-field" placeholder="End" accessibilityLabel="End time" invalid={!range().ok}
                value={composer.end.get()} onChange={(e) => { others(); composer.end.set(e.value); }} />
            </View>
          </If>
        </View>
      </Field>
      <If when={!allDay() && range().ok}>
        <Text class={TEXT.caption}>{"Times shown in " + localTimeZone() + " (local time)"}</Text>
      </If>

      <If when={composer.repeatVisible()}>
        <Field label="Repeat">
          <Select
            testID="event-repeat-selector"
            accessibilityLabel="Repeat"
            items={composer.repeatOptions()}
            value={composer.repeatValue()}
            onChange={(e) => composer.chooseRepeat(e.value)}
          />
        </Field>
        <If when={composer.recurrenceDetailsVisible()}>
          <View class="flex-row gap-3">
            <Field label="Repeat every">
              <View class="flex-row items-center gap-2">
                <View class={sizedBox("w-[64px]", "w", 64)}>
                  <Input accessibilityLabel="Repeat interval" value={composer.interval.get()}
                    onChange={(e) => composer.interval.set(e.value)} />
                </View>
                <Text class={TEXT.body}>
                  {Calendar.recurrenceIntervalUnit(composer.recurrenceFrequency(), composer.interval.get())}
                </Text>
              </View>
            </Field>
            <Field label="End after (optional)">
              <View class={sizedBox("w-[110px]", "w", 110)}>
                <Input placeholder="Occurrences" accessibilityLabel="Occurrences" value={composer.count.get()}
                  onChange={(e) => composer.count.set(e.value)} />
              </View>
            </Field>
          </View>
        </If>
      </If>

      </Titled>

      {/* Details: where, who and what. */}
      <Titled title="Details" bodyClass="gap-3 px-3 pt-4 pb-3">
      <Field label="Location or meeting link">
        <Input testID="event-location-field" placeholder="Room, address or link" value={composer.location.get()}
          onChange={(e) => { others(); composer.location.set(e.value); }} />
      </Field>

      <If when={composer.googleWrites() && source()?.canCreateMeet === true}>
        <Checkbox label="Add Google Meet" checked={composer.createMeet.get()}
          onChange={(e) => composer.createMeet.set(e.checked)} />
      </If>

      <If when={composer.guestsVisible()}>
        <Field label="Guests">
          <View class="gap-1">
            <Input
              testID="event-guests-field"
              placeholder="Guest email addresses, separated by commas"
              value={composer.guests.get()}
              onChange={(e) => { composer.setDescriptionFocused(false); composer.setGuestsFocused(true); composer.guests.set(e.value); }}
            />
            <If when={composer.guestSuggestionsOpen()}>
              <GuestSuggestions />
            </If>
          </View>
        </Field>
      </If>

      <Field label="Description">
        <Textarea
          rows={4}
          placeholder="Add event details"
          accessibilityLabel="Description"
          value={composer.notes.get()}
          onChange={(e) => { composer.setGuestsFocused(false); composer.setDescriptionFocused(true); composer.notes.set(e.value); }}
        />
      </Field>

      </Titled>

      <If when={composer.googleWrites()}>
        <Titled title="Options" bodyClass="gap-3 px-3 pt-4 pb-3">
        <View class="flex-row">
          <ToolButton label="More options..." icon={composer.advancedOptionsOpen.get() ? "chevronUp" : "chevronDown"}
            selected={composer.advancedOptionsOpen.get()}
            onPress={() => composer.advancedOptionsOpen.set(!composer.advancedOptionsOpen.get())} />
        </View>
        <If when={composer.advancedOptionsOpen.get()}>
          <AdvancedOptions />
        </If>
        <Field label="Event reminders">
          <Select
            testID="event-reminder-selector"
            accessibilityLabel="Event reminders"
            items={(composer.editing() ? ["preserve", "default", "none", "custom"] : ["default", "none", "custom"])
              .map((value) => ({ value, label: value === "preserve" ? "Keep existing" : value === "default"
                ? "Calendar default" : value === "none" ? "None" : "Custom reminder" }))}
            value={composer.reminderMode.get()}
            onChange={(e) => composer.reminderMode.set(e.value as ReminderMode)}
          />
        </Field>
        <If when={composer.reminderMode.get() === "custom"}>
          <View class="flex-row items-center gap-2">
            <View class={sizedBox("w-[80px]", "w", 80)}>
              <Input placeholder="Minutes" accessibilityLabel="Reminder minutes" value={composer.reminderMinutes.get()}
                onChange={(e) => composer.reminderMinutes.set(e.value)} />
            </View>
            <Text class={TEXT.body}>minutes before the event</Text>
          </View>
        </If>
        </Titled>
      </If>

      <MoveSeriesDialog />
    </View>
  );
}

function AdvancedOptions() {
  const motion = createMotion({ enter: enterRise() });
  return (
    <View style={motion.style} class="gap-3">
      <Field label="Time zone for repeating events"
        description="Repeating events follow this time zone. Dates and times above use your computer's local time.">
        <Input placeholder="e.g. Europe/Paris" value={composer.timeZone.get()} onChange={(e) => composer.timeZone.set(e.value)} />
      </Field>
      <Field label="Availability">
        <Select testID="event-availability-selector" accessibilityLabel="Availability" items={AVAILABILITY}
          value={composer.availability.get()} onChange={(e) => composer.availability.set(e.value)} />
      </Field>
      <Field label="Visibility">
        <Select testID="event-visibility-selector" accessibilityLabel="Visibility" items={VISIBILITY}
          value={composer.eventVisibility.get()} onChange={(e) => composer.eventVisibility.set(e.value)} />
      </Field>
    </View>
  );
}

/** Contacts matching the address being typed; arrows move, Return or Tab
 * takes one (the guestNext/guestPrevious/guestChoose keys). */
function GuestSuggestions() {
  const motion = createMotion({ enter: enterRise() });
  return (
    <View testID="event-guest-suggestions" role="list" style={motion.style}
      class={cx("gap-0.5 p-1 border border-border", RADIUS, FILL.surface)}>
      <Each of={composer.guestSuggestions()} key={(contact) => contact.email}>
        {(contact, index) => (
          <PickerRow
            label={contact().name || contact().email}
            detail={contact().name ? contact().email : undefined}
            icon="people"
            cursor={index() === composer.guestHighlight()}
            onPress={() => composer.acceptGuest(contact())}
          />
        )}
      </Each>
    </View>
  );
}

function ComposerFooter() {
  return (
    <View class="gap-2">
      <If when={composer.result() !== ""}>
        <Text testID="event-save-error" class={cx(TEXT.caption, composer.writePending() ? "" : TEXT.danger)}>
          {composer.result()}
        </Text>
      </If>
      <View class="flex-row flex-wrap justify-end gap-2">
        <Button label="Cancel" onPress={() => composer.close()} />
        <If when={composer.guestUpdate()}>
          <Button label="Save without email"
            disabled={composer.writePending() || composer.loadingSeries() || !composer.dateRange().ok}
            onPress={() => composer.submit("none")} />
        </If>
        {/* The one primary action; Ctrl+Enter (eventSave in the keymap) presses it too. */}
        <Button
          testID="event-save-button"
          variant="primary"
          label={composer.saveLabel()}
          loading={composer.busy()}
          disabled={!composer.canSave()}
          onPress={() => composer.submit("all")}
        />
      </View>
    </View>
  );
}

function MoveSeriesDialog() {
  const name = () => {
    const destination = composer.calendarChoices().find((row) => String(row.source.id) === composer.pendingCalendarId());
    return destination ? String(destination.source.name || destination.source.id) : "the chosen calendar";
  };
  return (
    <AlertDialog
      title="Move the entire series?"
      description={"Google Calendar can only move the entire recurring series to " + name()
        + ", not just this occurrence. The editor will open the entire series; unsaved changes to this occurrence will be discarded."}
      actionLabel="Move entire series"
      cancelLabel="Cancel"
      open={composer.moveSeriesOpen()}
      onOpenChange={(e) => { if (!e.open) composer.closeMoveSeries(); }}
      onAction={() => composer.moveEntireSeries()}
    />
  );
}
