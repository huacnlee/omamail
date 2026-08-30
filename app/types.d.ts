declare module "omarchy-theme" {
  /** `theme/colors.toml` — the palette. */
  export function current_colors(): string;
  /** `theme/shell.toml` — typography, the spacing scale, the state alphas. */
  export function current_shell(): string;
  /** Hyprland's `decoration:rounding`, so the window's corners match the desktop's. */
  export function current_corner_radius(): number;
  /** The concrete family the `monospace` fontconfig alias resolves to. */
  export function current_font_family(): string;
}

declare module "omamail-host-context" {
  export function configure(contextJson: string): Promise<string>;
}

declare module "omamail-gmail-setup" {
  export function dispatch(request: string): Promise<string>;
}

declare module "omamail-imap-setup" {
  export function dispatch(request: string): Promise<string>;
}

declare module "omamail-hey-setup" {
  export function dispatch(request: string): Promise<string>;
}

declare module "omamail-effects" {
  export type GoogleEventPayload = {
    summary: string;
    description?: string;
    location?: string;
    start: { date: string } | { dateTime: string };
    end: { date: string } | { dateTime: string };
    recurrence?: string[];
  };
  export type HeyQuery =
    | {
        kind: "box";
        box:
          | "imbox"
          | "feedbox"
          | "asidebox"
          | "laterbox"
          | "trailbox"
          | "bubblebox";
        unseen?: boolean;
        page?: string;
      }
    | { kind: "trash"; page?: string }
    | { kind: "label"; label: string; page?: string }
    | { kind: "search"; text: string; page?: string }
    | { kind: "drafts"; page?: string };

  export type HeyEffectRequest =
    | { operation: "hey.status"; deadlineMs: number }
    | ({
        operation: "hey.list";
        deadlineMs: number;
        query: HeyQuery;
      } & HeyBinding)
    | ({
        operation: "hey.thread";
        deadlineMs: number;
        messageId: string;
      } & HeyBinding)
    | ({
        operation: "hey.action";
        deadlineMs: number;
        action: "mark-read" | "mark-unread" | "trash" | "spam" | "untrash";
        messageIds: string[];
      } & HeyBinding);

  export type HeyBinding = {
    accountId: string;
    identity: {
      accountId: string;
      query: string;
      objectId: string;
      revision: number;
    };
  };

  export type HostEffectRequest =
    | HeyEffectRequest
    | {
        operation: "gmail.list";
        deadlineMs: number;
        identity: { accountId: string; objectId: string; revision: number };
        query: string;
        maxResults: number;
        pageToken: string | null;
      }
    | {
        operation: "gmail.detail";
        deadlineMs: number;
        identity: { accountId: string; objectId: string; revision: number };
        messageId: string;
        full: boolean;
      }
    | {
        operation: "gmail.action";
        deadlineMs: number;
        identity: { accountId: string; objectId: string; revision: number };
        action:
          | "mark-read"
          | "mark-unread"
          | "star"
          | "unstar"
          | "archive"
          | "unarchive"
          | "spam"
          | "trash"
          | "untrash";
        messageIds: string[];
      }
    | {
        operation: "imap.list";
        deadlineMs: number;
        identity: { accountId: string; objectId: string; revision: number };
        folder: string;
        criteria: string;
        maxResults: number;
        pageToken: string | null;
      }
    | {
        operation: "imap.detail";
        deadlineMs: number;
        identity: { accountId: string; objectId: string; revision: number };
        messageId: string;
        full: boolean;
      }
    | {
        operation: "imap.action";
        deadlineMs: number;
        identity: { accountId: string; objectId: string; revision: number };
        action:
          | "markRead"
          | "markUnread"
          | "star"
          | "unstar"
          | "archive"
          | "unarchive"
          | "trash"
          | "untrash";
        messageIds: string[];
      }
    | {
        type: "compose.send";
        deadlineMs: number;
        provider: "gmail" | "imap";
        accountId: string;
        draft: {
          mode: "new" | "mailto" | "reply" | "replyAll" | "forward";
          to: string[];
          cc: string[];
          bcc: string[];
          subject: string;
          body: string;
        };
      }
    | {
        type: "compose.draft";
        deadlineMs: number;
        provider: "gmail";
        accountId: string;
        draft: {
          mode: "new" | "mailto" | "reply" | "replyAll" | "forward";
          to: string[];
          cc: string[];
          bcc: string[];
          subject: string;
          body: string;
        };
      }
    | {
        type: "calendar.list";
        deadlineMs: number;
        provider: "google" | "caldav";
        sourceId: string;
        sourceUrl?: string;
        range: { startMs: number; endMs: number };
      }
    | {
        type: "calendar.google.write";
        deadlineMs: number;
        sourceId: string;
        accountId: string;
        eventId: string;
        payload: GoogleEventPayload;
      }
    | {
        type: "calendar.caldav.write";
        deadlineMs: number;
        sourceId: string;
        sourceUrl: string;
        url: string;
        payload: string;
      };

  // The host receives JSON text so its QJS boundary has one narrow primitive.
  export function dispatch(requestJson: string): Promise<string>;
}
declare module "omamail-outbox" {
  /** Tell the window whether a send is queued. Returns the previous answer. */
  export function hold(queued: boolean): boolean;
  /** Whether a close has been asked for and refused while something was queued. */
  export function close_requested(): boolean;
}

declare module "omamail-attachment" {
  export function open(request: string): Promise<string>;
  /**
   * Ask the desktop for files to attach. GPUI draws no file dialog, so the
   * host runs `scripts/attachment.sh choose`, which talks to the FileChooser
   * portal in a process of its own.
   *
   * `{"ok":true,"files":[{path,filename,mimeType,size}]}`, or
   * `{"ok":false,"error":…}` — cancelling is an answer rather than a failure,
   * so this resolves either way. No bytes: a draft carries a path and the
   * host opens the file when the message goes.
   */
  export function pick(): Promise<string>;
  /**
   * Keep a file the mail server handed over as bytes, so a draft can carry it
   * the way every other attachment is carried — by path, opened by the host at
   * send time. A forward's originals and a saved draft's files arrive this way
   * and no other.
   *
   * `{"filename":…,"mimeType":…,"data":<base64>}` in;
   * `{"ok":true,path,filename,mimeType,size}` or `{"ok":false,"error":…}` out.
   * The file lives in a private directory this process removes when it ends.
   */
  export function store(request: string): Promise<string>;
}

declare module "omamail-contacts" {
  /**
   * The desktop's address book, through `scripts/contact-suggestions.py`:
   * `{"ok":true,"contacts":[{name,email}]}`. Best-effort — no Thunderbird, no
   * Python and no address book all answer `ok:false` with an empty list, and
   * the completion falls back to the open mailbox's own senders.
   */
  export function read(): Promise<string>;
}

declare module "omamail-calendars" {
  /**
   * The calendars `~/.config/omamail/calendars.json` holds, in the shape
   * `calendar/Sources.js` reads and writes.
   *
   * `{"operation":"calendars.read"}` answers `{ok,text}` with the file's own
   * JSON — an empty list where nothing has been written yet, and a refusal
   * where the file will not parse, because answering "no calendars" is how a
   * configuration would be lost on the next write.
   * `{"operation":"calendars.write","payload":…}` publishes a serialized list
   * atomically at 0600 and answers with the text that landed. The host reads
   * the payload into the fields a source has and writes it back out from
   * them, so nothing else in it — a password above all — can reach the file.
   * `{"operation":"calendars.savePassword","sourceId":…,"password":…}` puts a
   * CalDAV password in the keyring under the identity the transport reads it
   * back by. It crosses in the request, never on a command line.
   */
  export function dispatch(request: string): Promise<string>;
}

declare module "omamail-notify" {
  /**
   * Raise a desktop notification. `{"summary":…,"body":…}`: the host builds
   * the argument vector, so a sender's display name starting with a dash is
   * never read as an option.
   */
  export function send(request: string): Promise<string>;
}

declare module "omamail-command" {
  /**
   * What another launch of Omamail asked this window to do:
   * `{"verb":"open"|"refresh"|"compose-mailto","payload":…}`, where the payload
   * is a `mailto:` URL and only on `compose-mailto`. The promise parks until
   * one arrives, so the window waits on the door rather than knocking on it.
   */
  export function next(): Promise<string>;
  /**
   * Bring the window forward, because a link asked for it. False when the
   * platform declined — Wayland without an activation token — which changes
   * nothing about the draft that is being opened behind it.
   */
  export function activate(): boolean;
}

declare module "omarchy-companion" {
  /**
   * Publish the unread total to `~/.local/state/omamail/status.json`, which is
   * the file `BarWidget.qml` reads through `bar/Status.js`. One integer: the
   * host writes the whole snapshot, and nothing about a message crosses.
   */
  export function set_unread(count: number): boolean;
}
