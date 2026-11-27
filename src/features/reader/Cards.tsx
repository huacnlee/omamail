// The meeting in the message, drawn as a meeting (InviteCard.qml), and what
// the agent found in it (EventSuggestionCard.qml). Application UI built from
// the calendar part and the agent's job: every value is still plain text.
import { computed, signal, Text, View, effect, untracked } from "nsh";
import { Button, Icon, TEXT, Titled, cx, type IconKey } from "../../ui";
import * as Calendar from "../../mail/message/calendar";
import { suggestionWhen, type EventSuggestion } from "../../mail/agent/events";

const ANSWERS = [
  { answer: "accepted", label: "Yes" },
  { answer: "tentative", label: "Maybe" },
  { answer: "declined", label: "No" },
] as const;
const MAIL_ANSWERS = [
  { answer: "accepted", label: "Email Yes" },
  { answer: "tentative", label: "Email Maybe" },
  { answer: "declined", label: "Email No" },
] as const;
const GUESTS_SHOWN = 6;

// Titled-border panels (DESIGN.md, Visual language v2), not filled cards.
const BODY = "px-4 pt-4 pb-3 gap-1.5";

function Line(props: { icon: IconKey; text: string; testID?: string }) {
  return (
    <View class="flex-row items-start gap-1.5">
      <View class="pt-0.5"><Icon name={props.icon} size={12} class={TEXT.secondary} /></View>
      <Text testID={props.testID} class={cx(TEXT.body, "flex-1")}>{props.text}</Text>
    </View>
  );
}

export function joinLabel(link: string): string {
  return String(link || "").indexOf("meet.google.com") > 0 ? "Join with Google Meet..." : "Join the call...";
}

export function goingLabel(response: string): string {
  return response === "accepted" ? "You are going" : response === "declined" ? "You are not going" : "You might be going";
}

export interface InviteCardProps {
  invite: any;
  response: string;
  canRespond: boolean;
  sending: boolean;
  fallbackAvailable: boolean;
  calendarUrl: string;
  onRespond: (answer: string) => void;
  onMailOnly: (answer: string) => void;
  onOpen: (url: string) => void;
  /** The saved calendar copy's line and its button (a provider whose calendar
   * does not answer for itself, with a destination chosen in Settings). */
  calendarState?: { visible: boolean; busy: boolean; text: string; canSave: boolean } | null;
  onSaveCalendar?: () => void;
}

export function InviteCard(props: InviteCardProps) {
  const cancelled = computed(() => props.invite.method === "CANCEL" || String(props.invite.status || "") === "CANCELLED");
  const when = computed(() => {
    const at = String(Calendar.formatWhen(props.invite) || "");
    const span = String(Calendar.formatDuration(props.invite) || "");
    return span === "" ? at : at + " · " + span;
  });
  const people = computed(() => {
    const organizer = props.invite.organizer;
    if (!organizer) return "";
    const host = String(organizer.name || organizer.email || "");
    const guests = String(Calendar.attendeeSummary(props.invite) || "");
    return guests === "" ? host : host + " · " + guests;
  });
  const attendees = computed<any[]>(() => (Array.isArray(props.invite.attendees) ? props.invite.attendees : []));
  const meet = computed(() => String(props.invite.meetLink || ""));
  return (
    <Titled testID="eventCard" role="group" title={String(Calendar.headline(props.invite) || "Event")} bodyClass={BODY}>
      <Text testID="invite-title" class={TEXT.title}>{String(props.invite.summary || "(no title)")}</Text>
      <If when={when() !== ""}>
        <Text class={TEXT.body}>{when()}</Text>
      </If>
      <If when={String(props.invite.recurrence || "") !== ""}>
        <Text class={TEXT.caption}>{String(props.invite.recurrence || "")}</Text>
      </If>
      <If when={String(props.invite.location || "") !== ""}>
        <Line icon="pin" text={String(props.invite.location || "")} />
      </If>
      <If when={people() !== ""}>
        <Line icon="people" text={people()} />
      </If>
      <If when={attendees().length > 0}>
        <View class="gap-0.5 pl-5">
          <Each of={attendees().slice(0, GUESTS_SHOWN)} key="index">
            {(guest) => (
              <Text class={TEXT.caption}>
                {String(guest().name || guest().email || "") + " — " + Calendar.partstatLabel(guest().partstat) + (guest().optional ? " (optional)" : "")}
              </Text>
            )}
          </Each>
          <If when={attendees().length > GUESTS_SHOWN}>
            <Text class={TEXT.caption}>{"and " + (attendees().length - GUESTS_SHOWN) + " more"}</Text>
          </If>
        </View>
      </If>
      <If when={meet() !== "" && !cancelled()}>
        <View class="flex-row pt-1">
          <Button testID="invite-join" label={joinLabel(meet())} size="small" onPress={() => props.onOpen(meet())} />
        </View>
      </If>
      <If when={props.canRespond && !props.fallbackAvailable}>
        <View testID="invite-rsvp" class="flex-row flex-wrap items-center gap-1.5 pt-1" role="group" accessibilityLabel="Going?">
          <Text class={TEXT.body}>Going?</Text>
          <Each of={ANSWERS} key={(a) => a.answer}>
            {(choice) => (
              <Button
                testID={"invite-" + choice().answer}
                label={choice().label}
                size="small"
                icon={props.response === choice().answer ? "check" : null}
                selected={props.response === choice().answer}
                disabled={props.sending}
                onPress={() => props.onRespond(choice().answer)}
              />
            )}
          </Each>
        </View>
      </If>
      <If when={props.fallbackAvailable && props.canRespond}>
        <View class="gap-1.5 pt-1">
          <Text class={TEXT.body}>
            Calendar attendance cannot be confirmed here. You can open Calendar or send a reply email only; email does not confirm your Calendar attendance.
          </Text>
          <View class="flex-row flex-wrap gap-1.5">
            <If when={props.calendarUrl !== ""}>
              <Button label="Open Calendar..." size="small" onPress={() => props.onOpen(props.calendarUrl)} />
            </If>
            <Each of={MAIL_ANSWERS} key={(a) => a.answer}>
              {(choice) => (
                <Button label={choice().label + "..."} size="small" disabled={props.sending} onPress={() => props.onMailOnly(choice().answer)} />
              )}
            </Each>
          </View>
        </View>
      </If>
      <If when={props.calendarState?.visible === true}>
        <View class="gap-1.5 pt-1">
          <Text testID="invitation-calendar-status" class={TEXT.caption}>{props.calendarState?.text ?? ""}</Text>
          <If when={props.calendarState?.canSave === true}>
            <View class="flex-row">
              <Button
                testID="invitation-calendar-save"
                label={cancelled() || props.response === "declined" ? "Remove saved event" : "Save / update calendar"}
                size="small"
                onPress={() => props.onSaveCalendar?.()}
              />
            </View>
          </If>
        </View>
      </If>
      <If when={!cancelled() && !props.canRespond && props.response !== ""}>
        <Text class={TEXT.caption}>{goingLabel(props.response)}</Text>
      </If>
    </Titled>
  );
}

export interface SuggestionsCardProps {
  suggestions: readonly EventSuggestion[];
  onAdd: (suggestion: EventSuggestion) => void;
  onDismiss: (key: string) => void;
}

export function suggestionHeading(count: number): string {
  return count === 1 ? "The agent found an event in this message" : "The agent found " + count + " events in this message";
}

/** Folded until asked: a guess about somebody's mail is a line, not a panel. */
export function SuggestionsCard(props: SuggestionsCardProps) {
  const expanded = signal(false);
  const look = computed(() => String(props.suggestions[0]?.jobId ?? ""));
  effect(() => {
    look();
    untracked(() => expanded.set(false));
  });
  return (
    <Titled testID="eventSuggestions" role="group" title="Agent" bodyClass="px-2 pt-3 pb-2 gap-1.5">
      <Button
        testID="suggestionHeader"
        label={suggestionHeading(props.suggestions.length)}
        variant="ghost"
        size="small"
        icon={expanded() ? "chevron-up" : "chevron-down"}
        accessibilityLabel={suggestionHeading(props.suggestions.length) + (expanded() ? ", shown" : ", hidden")}
        onPress={() => expanded.set(!expanded())}
      />
      <If when={expanded()}>
        <View class="gap-3 px-2 pb-1">
          <Each of={props.suggestions} key={(s) => s.key}>
            {(item) => (
              <View class="gap-0.5">
                <Text class={TEXT.title}>{item().title}</Text>
                <Text class={TEXT.body}>{suggestionWhen(item(), Date.now())}</Text>
                <If when={item().location !== ""}>
                  <Line icon="location" text={item().location} />
                </If>
                <If when={item().notes !== ""}>
                  <Text class={TEXT.caption}>{item().notes}</Text>
                </If>
                <View class="flex-row gap-1.5 pt-1">
                  <Button label="Add to calendar..." size="small" icon="calendar" onPress={() => props.onAdd(item())} />
                  <Button label="Dismiss" size="small" variant="ghost" onPress={() => props.onDismiss(item().key)} />
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>
    </Titled>
  );
}
