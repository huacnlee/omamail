// How the reader starts a draft: through compose's own `openCompose`, which
// owns the draft, its identity and the outbox. Nothing here sends mail; a
// list's unsubscribe address and an invitation answered by mail open as
// drafts the person sends themselves.
import { openCompose, type ComposeRequest } from "../compose/store";

export type DraftRequest = ComposeRequest;

/** A new draft with these fields (mailto:, unsubscribe, RSVP by mail). */
export function openDraft(draft: DraftRequest): boolean {
  openCompose(draft);
  return true;
}
