// What a provider's setup form is handed: the row it edits and what it may
// do with it. The form never edits the registry itself.
import type { Account, ProviderId } from "../../mail/accounts";

export interface SetupContext {
  provider: ProviderId;
  /** A new mailbox (a working row), not an existing one being edited. */
  adding: boolean;
  /** The registry row the form edits; -1 when it is gone. */
  index: () => number;
  account: () => Account | null;
  /** Whether Remove account is offered: never for the last mailbox or a working row. */
  canRemove: () => boolean;
  /** Saves the non-secret configuration; false when it collides with another mailbox (the form must not sign in then). */
  configure(values: Partial<Account>): boolean;
  /** The address the provider reported at sign-in (Gmail, HEY). */
  name(email: string): void;
  /** Signed in: leave the setup pages. */
  finish(): void;
  /** Asks, then removes the mailbox; resolves with the sentence when it could not. */
  remove(): Promise<string>;
  /** Tells the app's account status (app.setAccountStatus) that this page signed the mailbox in or out. */
  reportSignedIn(signedIn: boolean): void;
}
