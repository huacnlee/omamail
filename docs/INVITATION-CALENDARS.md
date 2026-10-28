# Accepted invitations

Settings → Calendars → Accepted invitations lets each mailbox without native calendar attendance choose a writable Google calendar. The default is “Don't save to a calendar”. The destination also appears in that mailbox's calendar view; its normal visibility setting still applies.

Yes and Maybe first send the normal RFC 5546 reply from the invited mailbox/alias. After mail success, Omamail imports a private schedule entry into the chosen calendar. It retains the invitation UID and organizer and sends no additional invitations from Google. Tentative replies create tentative entries. No removes only the copy this mailbox previously saved. Gmail continues using its native attendance operation.

The invitation card reports calendar-save success or failure separately from the reply. “Save / update calendar” retries the calendar operation without sending another email, including after reopening the message. An updated invitation is applied when answered or explicitly saved; a cancellation offers “Remove saved event”. Reading or fetching a message alone never writes to a calendar. This is invitation handling, not background Proton Calendar synchronization.

The backend matches by destination, UID and organizer and checks its mailbox ownership marker before modifying a copy. A native or manually imported event with the same UID is left alone. Older sequence numbers cannot overwrite a newer saved invitation; patches use the current ETag and `sendUpdates=none`. Concurrent saves within the backend are serialized. A retry looks up the UID again before importing, including after a lost response. A manually recreated event with a different UID cannot be recognized as the same invitation. Google consistency and external calendar clients can still cause conflicts; the operation reports failure rather than automatically repeating writes.

Whole recurring series preserve their recurrence rule and excluded dates. An occurrence update targets its original start in an already imported series; an occurrence-only invitation cannot create a second series. Unresolved zones or incomplete dates are refused. Google must recognize recurring time-zone identifiers; the original invitation remains available if it does not.

`calendar.saveInvitation` and Google `calendar.request` import support require API 9. The published API-8 backend still sends RSVP email, while the new destination controls are disabled. The exact published pin remains unchanged until a normal backend release.
