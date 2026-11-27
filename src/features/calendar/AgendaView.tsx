// The agenda (CalendarView.qml's agenda page): the range's events from now
// on, one row each, in a virtualized list since a month can hold hundreds.
import { List, Text, View } from "nsh";
import { cx, scaled, TEXT } from "../../ui";
import { agendaWhen, EventLine } from "./parts";
import { eventKey, view } from "./service";
import type { CalendarEvent } from "./controller";

export function AgendaView() {
  return (
    <List
      testID="calendar-agenda"
      class="flex-1"
      contentClass="gap-1.5 p-4"
      each={view.agendaEvents()}
      keyExtractor={(event: CalendarEvent) => eventKey(event)}
      empty={
        <View class="flex-1 items-center justify-center p-6">
          <Text class={cx(TEXT.caption, "text-center")}>No upcoming events in this date range.</Text>
        </View>
      }
    >
      {(event) => (
        <View style={{ minHeight: scaled(52) }}>
          <EventLine
            testID={"calendar-agenda-" + eventKey(event())}
            event={event()}
            when={agendaWhen(event())}
            selected={view.selectedEventId() === eventKey(event())}
            onPress={() => view.activateEvent(event())}
          />
        </View>
      )}
    </List>
  );
}
