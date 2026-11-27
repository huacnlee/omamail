// The calendar's bar: the period (previous, the date picker, next, Today)
// on the left, loading and the view switch on the right. The Qt client's
// calendarToolbar; its view ComboBox is a segmented control here, since the
// four views are few, exclusive and worth seeing at once.
import { Text, View, signal } from "nsh";
import * as Keys from "../../keys/keymap";
import * as Calendar from "../../mail/calendar/calendar";
import { formatDate, MONTHS } from "../../mail/calendar/format";
import { ActionBar, ActionBarGroup, Calendar as DayPicker, Popover, SegmentedControl, Spinner, ToolButton, cx, TEXT } from "../../ui";
import { composer, controller, view } from "./service";
import type { ViewMode } from "./view";
import type { CalendarDay } from "../../mail/calendar/types";


function shortcut(id: string): string {
  return Keys.displayFor(Keys.byId(id));
}

const VIEW_OPTIONS: Array<{ value: ViewMode; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "agenda", label: "Agenda" },
];

/** The period's name: "19 November 2026", "16–22 November 2026", "November 2026". */
export function periodTitle(mode: ViewMode, weekMs: number, monthMs: number, weekDays: CalendarDay[]): string {
  if (mode === "day") return formatDate(new Date(weekMs), "d MMMM yyyy");
  if (mode === "week") return Calendar.weekTitle(weekDays);
  const month = new Date(monthMs);
  return MONTHS[month.getMonth()] + " " + month.getFullYear();
}

export function CalendarToolbar() {
  const pickerOpen = signal(false);
  return (
    <ActionBar testID="calendar-toolbar" label="Calendar" edge="top">
      <ActionBarGroup label="Period">
        <ToolButton label="Previous period" icon="chevronLeft" iconOnly shortcut={shortcut("calendarPreviousPeriod")}
          onPress={() => view.movePeriod(-1)} />
        <Popover
          open={pickerOpen()}
          placement="bottom"
          align="start"
          onOpenChange={(e) => pickerOpen.set(e.open)}
          trigger={
            <ToolButton
              testID="calendar-date-picker"
              label={periodTitle(view.viewMode(), view.visibleWeek(), view.visibleMonth(), view.weekDays())}
              icon="calendar"
              selected={pickerOpen()}
              onPress={() => pickerOpen.set(!pickerOpen())}
            />
          }
        >
          <DayPicker
            value={Calendar.isoDate(new Date(view.visibleWeek()))}
            onChange={(e) => {
              const [year, month, day] = e.value.split("-").map(Number);
              pickerOpen.set(false);
              view.showDate(new Date(year, month - 1, day).getTime());
            }}
          />
        </Popover>
        <ToolButton label="Next period" icon="chevronRight" iconOnly shortcut={shortcut("calendarNextPeriod")}
          onPress={() => view.movePeriod(1)} />
        <View class="w-2" />
        <ToolButton label="Today" shortcut={shortcut("calendarToday")} onPress={() => view.goToday()} />
      </ActionBarGroup>
      <View class="flex-1" />
      <View class="flex-row items-center gap-2">
        <ToolButton testID="calendar-new-event" label="Create event..." icon="addEvent" shortcut={shortcut("createEvent")}
          disabled={controller.noCalendars()} onPress={() => composer.begin()} />
        <If when={controller.loading()}>
          <View class="flex-row items-center gap-1.5">
            <Spinner size={14} label="Loading calendars" />
          </View>
        </If>
        <SegmentedControl
          testID="calendar-view-selector"
          label="Calendar view"
          options={VIEW_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          value={view.viewMode()}
          onChange={(mode) => view.setView(mode)}
        />
      </View>
    </ActionBar>
  );
}

/** The error above the views, with the two actions a disabled Google
 * Calendar API needs, and the note that what shows may be stale. */
export function CalendarErrors(props: { onCopy: (text: string) => void; onOpen: (url: string) => void }) {
  return (
    <If when={controller.lastError() !== ""}>
      <View class="gap-1 px-4 pt-3">
        <View testID="calendar-error" class="flex-row items-center gap-2 px-3 py-2 border border-danger bg-danger/10 rounded-(--radius)">
          <Text class={cx(TEXT.body, "flex-1 line-clamp-2")}>{controller.lastError()}</Text>
          <If when={controller.lastErrorKind() === "googleApiDisabled"}>
            <View class="flex-row items-center gap-1">
              <ToolButton testID="calendarErrorCopy" label="Copy" icon="copy" onPress={() => props.onCopy(controller.lastError())} />
              <ToolButton testID="calendarApiEnable" label="Enable API..." icon="browser"
                onPress={() => props.onOpen(Calendar.googleCalendarApiUrl())} />
            </View>
          </If>
        </View>
        <If when={controller.events().length > 0}>
          <Text class={TEXT.caption}>Showing available events. Some calendar data may be out of date.</Text>
        </If>
      </View>
    </If>
  );
}
