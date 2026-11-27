// Delivered reminders that still want an answer (CalendarReminderPanel.qml):
// the system notification is one way in, this list is the other, so a
// reminder stays actionable until it is snoozed, dismissed or its event ends.
// The event's title is the organizer's text and shows as plain text.
import { Text, View, createMotion } from "nsh";
import * as Calendar from "../../mail/calendar/calendar";
import { enterRise, Titled, ToolButton, cx, TEXT } from "../../ui";
import { localeHourCycle } from "./time";
import { calendarSettings } from "./settings";
import { reminders } from "./service";
import type { ReminderRecord } from "./reminders";


export function ReminderPanel(props: {
  /** Only this event's reminders (inside its detail), by key prefix. */
  eventKey?: string;
  /** Inside the event's detail: no "Open event..." */
  inDetail?: boolean;
}) {
  const inbox = reminders.inbox;
  const records = () => inbox.records().filter((record) =>
    !props.eventKey || record.key === props.eventKey);
  return (
    <If when={records().length > 0 || inbox.lastError() !== ""}>
      <Titled testID="calendar-reminders" title="Reminders" role="group" bodyClass="gap-1.5 px-3 pt-4 pb-3">
        <Each of={records()} key={(record: ReminderRecord) => record.key + ":" + record.noticeId}>
          {(record: () => ReminderRecord) => <ReminderRow record={record()} inDetail={!!props.inDetail} />}
        </Each>
        <If when={inbox.lastError() !== ""}>
          <Text class={cx(TEXT.caption, TEXT.danger)}>{inbox.lastError()}</Text>
        </If>
      </Titled>
    </If>
  );
}

function ReminderRow(props: { record: ReminderRecord; inDetail: boolean }) {
  const motion = createMotion({ enter: enterRise() });
  const inbox = reminders.inbox;
  const pending = () => inbox.pending(props.record.key);
  return (
    <View style={motion.style} class="flex-row flex-wrap items-center gap-2">
      <Text class={cx(TEXT.body, "flex-1 line-clamp-1")}>
        {String(props.record.title || "Untitled event") + " · "
          + Calendar.dateTimeLabel(props.record.start, "ddd", localeHourCycle())}
      </Text>
      <If when={!props.inDetail}>
        <ToolButton label="Open event..." disabled={pending()} onPress={() => inbox.open(props.record)} />
      </If>
      <ToolButton label={"Snooze " + calendarSettings.snoozeMinutes() + " min"} icon="clock" disabled={pending()}
        onPress={() => inbox.action(props.record.key, "snooze", props.record.noticeId)} />
      <ToolButton label="Dismiss" icon="check" disabled={pending()}
        onPress={() => inbox.action(props.record.key, "dismiss", props.record.noticeId)} />
    </View>
  );
}
