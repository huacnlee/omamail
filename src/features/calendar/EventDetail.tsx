// One event's details (CalendarEventDetail.qml): when, which calendar, the
// meeting and the place, the description, the guests and their answers, and
// what can be done with it. Every field is the organizer's text: shown as
// plain, selectable text. Links leave the app only when they are https or
// http (Html.externallyOpenableHttpUrl), and only when pressed.
import { Clipboard, Scroll, Text, View, createMotion, openUrl, signal } from "nsh";
import * as Calendar from "../../mail/calendar/calendar";
import { formatDate } from "../../mail/calendar/format";
import { externallyOpenableHttpUrl } from "../../mail/message/html";
import { ActionBar, enterRise, Icon, LoadingRow, Titled, ToolButton, cx, TEXT, sizedBox } from "../../ui";
import { eventTitle, eventTone } from "./parts";
import { ReminderPanel } from "./ReminderPanel";
import { composer, controller, deletion, eventKey, view } from "./service";
import { localeHourCycle } from "./time";
import type { CalendarEvent, CalendarSource } from "./controller";

/** Google's answer to a Meet request ("pending", "success", "failure"), "" for none. */
function conferenceStatusCode(data: unknown): string {
  const request = data && typeof data === "object" ? (data as { createRequest?: unknown }).createRequest : undefined;
  const status = request && typeof request === "object" ? (request as { status?: unknown }).status : undefined;
  const code = status && typeof status === "object" ? (status as { statusCode?: unknown }).statusCode : undefined;
  return String(code || "");
}


/** "Thursday, 19 November 2026 · 09:30–10:00", all-day and multi-day alike. */
export function dateSummary(event: CalendarEvent | null): string {
  if (!event || !event.start) return "";
  const start = new Date(Number(event.start.ms || 0));
  const end = event.end ? new Date(Number(event.end.ms || event.start.ms || 0)) : start;
  const cycle = localeHourCycle();
  if (event.start.allDay) {
    const inclusiveEnd = new Date(Math.max(start.getTime(), end.getTime() - 1));
    if (start.toDateString() === inclusiveEnd.toDateString()) return formatDate(start, "dddd, d MMMM yyyy") + " · All day";
    return formatDate(start, "d MMMM yyyy") + " – " + formatDate(inclusiveEnd, "d MMMM yyyy") + " · All day";
  }
  const startDay = formatDate(start, "dddd, d MMMM yyyy");
  if (start.toDateString() === end.toDateString())
    return startDay + " · " + Calendar.timeRangeLabel(start.getTime(), end.getTime(), cycle);
  return startDay + " · " + Calendar.timeLabel(start.getTime(), cycle) + " – "
    + Calendar.dateTimeLabel(end.getTime(), "dddd, d MMMM yyyy", cycle, " · ");
}

/** Whether the event can be deleted: a read-only calendar and an event this
 * client cannot address (a CalDAV occurrence, an href off the source's own
 * origin) draw no button rather than a refusal. */
export function canDeleteEvent(source: CalendarSource | null, event: CalendarEvent | null): boolean {
  if (!source || !event || source.readOnly === true) return false;
  if (source.kind === "google") return String(event.googleId || "") !== "";
  if (source.kind === "microsoft") return String(event.graphId || "") !== "";
  return String(event.href || "") !== "" && String(event.recurrenceRule || "") === ""
    && Number(event.recurrenceIdMs || 0) <= 0
    && String((event.source && event.source.recurrenceId) || "") === ""
    && Calendar.caldavEventUrl(source.url, event) !== "";
}

function open(url: string) {
  const link = externallyOpenableHttpUrl(url);
  if (link) openUrl(link).catch(() => controller.reportError("Could not open the link"));
}

export function EventDetail() {
  const motion = createMotion({ enter: enterRise(8) });
  const copied = signal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  const event = () => view.detailEvent();
  const source = () => (event() ? controller.findSource(String(event()!.sourceId || "")) : null);
  const canDelete = () => canDeleteEvent(source(), event());
  const canWrite = () => canDelete() && Calendar.writeRefusal(source(), event()) === "";
  const meetingLink = () => externallyOpenableHttpUrl(event()?.meetLink);
  const locationText = () => String(event()?.location || "").trim();
  const locationLink = () => externallyOpenableHttpUrl(event()?.location);
  const locationIsPlace = () => locationText() !== "" && locationLink() === "";
  const mapLink = () => locationIsPlace()
    ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(locationText()) : "";
  const providerLink = () => externallyOpenableHttpUrl(event()?.href);
  const conferenceStatus = () => conferenceStatusCode(event()?.conferenceData);
  const attendees = () => Calendar.attendeeRows(event()) as Array<{ name: string; email: string; label: string;
    optional: boolean; self: boolean }>;
  const tone = () => eventTone(event());

  async function copy(text: string, flash = false) {
    const written = await Clipboard.writeText(text).catch(() => false);
    if (!written) { controller.reportError("Could not copy to the clipboard"); return; }
    if (!flash) return;
    copied.set(true);
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => copied.set(false), 2000);
  }

  return (
    <View testID="calendar-event-detail" style={motion.style} class="flex-1 border-l border-border bg-background">
      <ActionBar label="Event" edge="top">
        <ToolButton label="Back" icon="back" iconOnly shortcut="Esc" onPress={() => view.closeDetail()} />
        <View class="flex-1" />
        <If when={canWrite()}>
          <ToolButton testID="event-edit" label="Edit..." icon="edit"
            onPress={() => composer.beginEdit(String(event()!.sourceId || ""), event()!)} />
        </If>
        <If when={canDelete()}>
          <ToolButton testID="event-delete" label="Delete..." icon="trash" variant="danger"
            onPress={() => deletion.ask(String(event()!.sourceId || ""), event()!)} />
        </If>
      </ActionBar>
      <Scroll class="flex-1" contentClass="gap-4 p-4">
        <View selectable class="gap-5">
        <View class="flex-row gap-2.5">
          <View class={cx("w-[3px] self-stretch", tone().bar)} />
          <View class="flex-1 gap-1">
            <Text testID="event-title-text" role="header" class={cx(sizedBox("text-base", "text", 16), "text-bright font-semibold")}>
              {eventTitle(event())}
            </Text>
            <Text testID="event-date-text" class={TEXT.body}>{dateSummary(event())}</Text>
            <Text testID="event-calendar-text" class={TEXT.caption}>
              {source() ? String(source()!.name || source()!.id || "Calendar") : "Calendar"}
            </Text>
          </View>
        </View>

        <If when={view.detailLoading()}>
          <LoadingRow label="Refreshing event details..." />
        </If>
        <If when={view.detailError() !== ""}>
          <Text class={cx(TEXT.caption, TEXT.danger)}>{view.detailError()}</Text>
        </If>

        <ReminderPanel eventKey={eventKey(event())} inDetail />

        <If when={meetingLink() !== ""}>
          <Titled title="Meeting link" bodyClass="gap-2 px-3 pt-4 pb-3">
            <View class="flex-row items-center gap-1">
              <Text class={cx(TEXT.body, "flex-1 line-clamp-2")}>{meetingLink()}</Text>
              <ToolButton label={copied() ? "Copied" : "Copy meeting link"} icon={copied() ? "check" : "copy"} iconOnly
                onPress={() => copy(meetingLink(), true)} />
            </View>
            <ToolButton testID="event-join" label="Join meeting..." icon="video" onPress={() => open(meetingLink())} />
          </Titled>
        </If>

        <If when={locationText() !== ""}>
          <View class="flex-row gap-2">
            <Icon name="location" size={14} class="text-text-secondary mt-0.5" />
            <Text testID="event-location-text" class={cx(TEXT.body, "flex-1")}>{locationText()}</Text>
          </View>
        </If>

        <If when={event()?.eventType === "fromGmail"}>
          <Text class={TEXT.caption}>
            Created automatically from Gmail. Google does not allow apps to change its time or event details.
          </Text>
        </If>

        <If when={String(event()?.description || "") !== ""}>
          <Text testID="event-description-text" class={TEXT.body}>{String(event()!.description)}</Text>
        </If>

        <If when={attendees().length > 0}>
          <Titled title={"Guests · " + attendees().length} bodyClass="pt-3 pb-1">
            <Each of={attendees()} key="index">
              {(guest) => (
                <View class="flex-row gap-2 px-3 py-1.5">
                  <Icon
                    name={guest().label === "Accepted" ? "check" : guest().label === "Declined" ? "close" : "info"}
                    size={14}
                    label={guest().label}
                    class={guest().label === "Accepted" ? "text-success" : guest().label === "Declined" ? "text-danger" : "text-text-secondary"}
                  />
                  <View class="flex-1">
                    <Text class={TEXT.body}>{guest().name + (guest().self ? " (you)" : "")}</Text>
                    <Text class={TEXT.caption}>
                      {guest().label + (guest().optional ? " · Optional" : "")
                        + (guest().email && guest().email !== guest().name ? " · " + guest().email : "")}
                    </Text>
                  </View>
                </View>
              )}
            </Each>
          </Titled>
        </If>

        <If when={conferenceStatus() === "pending" || conferenceStatus() === "failure"}>
          <Text class={TEXT.caption}>
            {conferenceStatus() === "pending" ? "Google Meet is being created. Refresh to check its status."
              : "The event was saved, but Google Meet could not be created."}
          </Text>
        </If>

        <View class="flex-row flex-wrap gap-1.5">
          <If when={locationLink() !== "" && locationLink() !== meetingLink()}>
            <ToolButton label="Open location" icon="location" onPress={() => open(locationLink())} />
          </If>
          <If when={locationIsPlace()}>
            <ToolButton testID="event-open-map" label="Open in Google Maps" icon="location" onPress={() => open(mapLink())} />
          </If>
          <If when={locationText() !== ""}>
            <ToolButton testID="event-copy-location" label="Copy location" icon="copy" onPress={() => copy(locationText())} />
          </If>
          <If when={providerLink() !== "" && providerLink() !== meetingLink()}>
            <ToolButton label="Open in provider..." icon="browser" onPress={() => open(providerLink())} />
          </If>
        </View>
        </View>
      </Scroll>
    </View>
  );
}
