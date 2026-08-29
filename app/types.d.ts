declare module "omarchy-theme" {
  export function current_colors(): string;
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
declare module "omamail-attachment" {
  export function open(request: string): Promise<string>;
}
