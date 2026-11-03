# Accepted invitations

Settings → Calendars → Accepted invitations lets each mailbox without native calendar attendance choose a writable Google, CalDAV or iCloud calendar. The default is “Don't save to a calendar”. The destination also appears in that mailbox's calendar view; its normal visibility setting still applies.

Yes and Maybe first send the normal RFC 5546 reply from the invited mailbox/alias. After mail success, Omamail saves a private schedule entry into the chosen calendar. It retains the invitation UID and organizer and sends no additional invitations from Google. Tentative replies create tentative entries. No removes only the copy this mailbox previously saved. Gmail continues using its native attendance operation.

The invitation card reports calendar-save success or failure separately from the reply. “Save / update calendar” retries the calendar operation without sending another email, including after reopening the message. An updated invitation is applied when answered or explicitly saved; a cancellation offers “Remove saved event”. Reading or fetching a message alone never writes to a calendar. This is invitation handling, not background Proton Calendar synchronization.

The backend matches by destination, UID and organizer and checks its mailbox ownership marker before modifying a copy. A native or manually imported event with the same UID is left alone. Older sequence numbers cannot overwrite a newer saved invitation; patches use the current ETag and `sendUpdates=none`. Concurrent saves within the backend are serialized. A retry looks up the UID again before importing, including after a lost response. A manually recreated event with a different UID cannot be recognized as the same invitation. Google consistency and external calendar clients can still cause conflicts; the operation reports failure rather than automatically repeating writes.

Whole recurring series preserve their recurrence rule and excluded dates. An occurrence update targets its original start in an already imported series; an occurrence-only invitation cannot create a second series. Unresolved zones or incomplete dates are refused. Google must recognize recurring time-zone identifiers; the original invitation remains available if it does not.

## CalDAV and iCloud destinations

A CalDAV copy is the invitation's own event: its UID, sequence, summary, description, location, recurrence rule and exclusions, and the organiser's DTSTART/DTEND lines with their VTIMEZONE definitions. ORGANIZER and ATTENDEE lines are never written. A CalDAV server that schedules (RFC 6638) would otherwise send its own reply to the organiser, and the mail reply has already done that. The backend refuses a copy that holds any other property or component, including alarms and URLs (a time zone's `TZURL` too).

The backend finds an existing copy with a `calendar-query` REPORT on the UID. It identifies a managed copy by its `X-OMAMAIL-MAILBOX`, `X-OMAMAIL-ORGANIZER` and `X-OMAMAIL-SEQUENCE` properties. An event with the same UID and the same organiser but no marker is a native copy and is left alone; a different organiser is refused. A new copy is created with `If-None-Match: *`; updates and removals use the resource's ETag. An occurrence update replaces or adds that occurrence in the saved series; declining or cancelling an occurrence adds an EXDATE that records the decline's sequence, and a later answer to that occurrence replaces it. An occurrence is checked against its own saved sequence, or the series' when it has none, so an older invitation never overwrites a newer answer. Saving the whole series again keeps occurrence changes and declines that came from newer mail. A REPORT object the backend cannot read stops the save rather than risk a second copy.

CalDAV and iCloud destinations require API 10. On an API-9 backend the settings list offers only Google calendars and says the backend needs an update when a CalDAV calendar is connected.

## Backend versions

`calendar.saveInvitation` and Google `calendar.request` import support require API 9. The published API-8 backend still sends RSVP email, while the new destination controls are disabled. The exact published pin remains unchanged until a normal backend release.
