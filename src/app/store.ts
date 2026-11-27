// The app's shared navigation and selection state: what every feature reads
// and few write. Mail data itself is owned by the backend and by each
// feature's store (src/features/<feature>/store.ts); this file holds only the
// state that crosses features. Port of App.qml's nav/cursor/selection and
// account/Navigation.js.
//
// Navigation is one history stack (src/app/navigation.ts): `page()`,
// `overlay()` and `readerOpen()` are read off it, and `back()` is the one
// way out, so Back always retraces what the user did.
import { batch, computed, signal, untracked } from "nsh";
import * as Nav from "./navigation";

/** Where the main pane is. `reader` replaces the list only in compact mode. */
export type Page = "mail" | "calendar" | "settings" | "setup";
/** Transient surfaces above the window; one at a time. `compose`,
 * `eventComposer` and `shortcuts` are history entries (Back closes them);
 * the others are popups the shell dismisses. */
export type Overlay = "" | "compose" | "accounts" | "shortcuts" | "labels" | "move" | "search" | "eventComposer";

export interface AccountRef {
  id: string;
  email: string;
  provider: string;
  label: string;
  /** The name the user chose for it, "" when none was (`label` then falls
   * back to the address's local part). */
  name?: string;
  /** Its session is signed in (Qt's host.ready), when the session says. */
  signedIn?: boolean;
  /** Its session is checking for mail. */
  busy?: boolean;
  /** Its session's last error, "" when none. Untrusted server text: plain text only. */
  error?: string;
  /** The IMAP server, for IMAP accounts that name one (iCloud is told by it). */
  imapHost?: string;
}

/** The part of an account its session reports. */
export type AccountStatus = Partial<Pick<AccountRef, "signedIn" | "busy" | "error">>;

const accountsSignal = signal<AccountRef[]>([]);
const accountIdSignal = signal<string>(""); // "" = unified, when more than one account
const mailboxSignal = signal<string>("inbox");
/** The history stack. Starts on the list; bootstrap moves it to the picker
 * when there is no account. */
const navSignal = signal<Nav.NavEntry[]>([Nav.entry("list")]);
/** A popup over the window that is not a place (accounts, labels, move). */
const popupSignal = signal<Overlay>("");
/** Where the next keyboard action applies. */
const cursorIdSignal = signal<string>("");
/** What the reader shows. Separate from the cursor (docs/DESIGN.md). */
const selectedIdSignal = signal<string>("");
/** Checked rows for batch actions, by message id. */
const checkedSignal = signal<string[]>([]);
const querySignal = signal<string>("");
const sidebarCollapsedSignal = signal<boolean>(false);
const noticeSignal = signal<string>("");
/** The search field has the keyboard focus (docs/KEYS.md `search`). */
const searchFocusedSignal = signal<boolean>(false);
/** Bumped to ask the search field to take the focus (`/`). */
const searchFocusRequestSignal = signal<number>(0);
/** Bumped to ask the window to close (Back on a root). */
const closeRequestSignal = signal<number>(0);

const PAGE_OF: Record<Nav.NavKind, Page> = {
  list: "mail", reader: "mail", calendar: "calendar", calendarDetail: "calendar",
  settings: "settings", picker: "setup", setup: "setup",
  compose: "mail", eventComposer: "calendar", help: "mail",
};
const OVERLAY_OF: Partial<Record<Nav.NavKind, Overlay>> = {
  compose: "compose", eventComposer: "eventComposer", help: "shortcuts",
};

const navPage = computed(() => Nav.page(navSignal()));
const navOverlay = computed(() => Nav.overlay(navSignal()));
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function setNav(next: Nav.NavEntry[]) {
  navSignal.set(next);
}

/** Drops `kind` and everything above it, if it is on the stack. */
function dropKind(kind: Nav.NavKind) {
  const stack = navSignal();
  const at = stack.map((e) => e.kind).lastIndexOf(kind);
  if (at > 0) setNav(stack.slice(0, at));
}

export const app = {
  accounts: () => accountsSignal(),
  accountId: () => accountIdSignal(),
  account: computed(() => accountsSignal().find((a) => a.id === accountIdSignal()) ?? null),
  unified: computed(() => accountIdSignal() === "" && accountsSignal().length > 1),
  mailbox: () => mailboxSignal(),
  page: computed<Page>(() => PAGE_OF[navPage().kind]),
  overlay: computed<Overlay>(() => {
    const popup = popupSignal();
    if (popup !== "") return popup;
    const top = navOverlay();
    return top ? OVERLAY_OF[top.kind] ?? "" : "";
  }),
  cursorId: () => cursorIdSignal(),
  selectedId: () => selectedIdSignal(),
  checked: () => checkedSignal(),
  query: () => querySignal(),
  sidebarCollapsed: () => sidebarCollapsedSignal(),
  /** The reader is the page (in compact mode it replaces the list). */
  readerOpen: computed(() => navPage().kind === "reader"),
  notice: () => noticeSignal(),

  // ------------------------------------------------------------- history

  /** The whole stack, for the shell and tests. */
  nav: () => navSignal(),
  /** The topmost page entry (`reader`, `settings`, `picker`, ...). */
  navPage: () => navPage(),
  /** The topmost overlay entry, or null. */
  navOverlay: () => navOverlay(),
  composing: computed(() => navOverlay()?.kind === "compose"),
  helpOpen: computed(() => navOverlay()?.kind === "help"),
  calendarVisible: computed(() => {
    const kind = navPage().kind;
    return kind === "calendar" || kind === "calendarDetail";
  }),
  /** Settings, the picker or a setup form: a page over the mail. */
  showPage: computed(() => {
    const kind = navPage().kind;
    return kind === "settings" || kind === "picker" || kind === "setup";
  }),
  push(kind: Nav.NavKind, fields?: Record<string, unknown>) {
    setNav(Nav.push(navSignal(), Nav.entry(kind, fields)));
  },
  resetNav(stack: Nav.NavEntry[]) {
    setNav(Nav.copy(stack));
  },
  /** Back one step. On a root, clears a search if there is one and else asks
   * the window to close (`closeRequests`). */
  back() {
    const stack = navSignal();
    const leaving = Nav.top(stack);
    if (leaving.kind === "reader") {
      selectedIdSignal.set("");
    }
    const next = Nav.pop(stack);
    if (next === stack) {
      if (querySignal() !== "") querySignal.set("");
      else closeRequestSignal.update((n) => n + 1);
      return;
    }
    setNav(next as Nav.NavEntry[]);
  },
  /** Back without closing the window: the mouse's back button. */
  backWithoutClosing() {
    const stack = navSignal();
    if (stack.length > 1) app.back();
  },
  closeRequests: () => closeRequestSignal(),

  // ------------------------------------------------------- the old API

  setAccounts(list: AccountRef[]) {
    batch(() => {
      accountsSignal.set(list);
      if (accountIdSignal() !== "" && !list.some((a) => a.id === accountIdSignal())) {
        accountIdSignal.set(list.length === 1 ? list[0].id : "");
      }
      if (list.length === 1 && accountIdSignal() === "") accountIdSignal.set(list[0].id);
    });
  },
  /** Records what an account's session reports (Qt's host.ready,
   * listLoading and lastError), for whichever feature runs the session. The
   * registry says none of it, so a registry reload keeps it. */
  setAccountStatus(id: string, status: AccountStatus) {
    const list = untracked(() => accountsSignal());
    const index = list.findIndex((a) => a.id === id);
    if (index < 0) return;
    const current = list[index];
    const next = { ...current, ...status };
    if (next.signedIn === current.signedIn && next.busy === current.busy && next.error === current.error) return;
    const copy = list.slice();
    copy[index] = next;
    accountsSignal.set(copy);
  },
  setAccountSignedIn(id: string, signedIn: boolean) {
    app.setAccountStatus(id, { signedIn });
  },
  openAccount(id: string) {
    batch(() => {
      accountIdSignal.set(id);
      app.clearSelection();
      if (!app.calendarVisible()) setNav(Nav.resetTo(navSignal(), "list"));
    });
  },
  openMailbox(id: string) {
    batch(() => {
      mailboxSignal.set(id);
      app.clearSelection();
      setNav(Nav.resetTo(navSignal(), "list"));
    });
  },
  /** `mail` and `calendar` swap the root; `settings` and `setup` are pushed
   * over it, so Back returns where the user was. */
  openPage(page: Page) {
    batch(() => {
      popupSignal.set("");
      const stack = navSignal();
      if (page === "mail" || page === "calendar") {
        const root = page === "mail" ? "list" : "calendar";
        if (stack[0]?.kind === root) {
          // Leave pages above the root, keep a reader under them.
          const keep = stack.filter((e, i) => i === 0 || e.kind === "reader" || e.kind === "calendarDetail");
          setNav(Nav.copy(keep));
        } else {
          setNav(Nav.replaceRoot(stack, root));
          if (page === "calendar") selectedIdSignal.set("");
        }
      } else if (page === "settings") {
        if (navPage().kind !== "settings") setNav(Nav.push(stack, Nav.entry("settings")));
      } else if (accountsSignal().length === 0) {
        setNav(Nav.rootFor({ anyReady: false, hasSavedAccounts: false }));
      } else if (navPage().kind !== "picker" && navPage().kind !== "setup") {
        setNav(Nav.push(stack, Nav.entry("picker")));
      }
    });
  },
  openOverlay(overlay: Overlay) {
    if (overlay === "compose") app.push("compose");
    else if (overlay === "eventComposer") app.push("eventComposer");
    else if (overlay === "shortcuts") app.push("help");
    else popupSignal.set(overlay);
  },
  /** Closes the popup if one is up, else the topmost overlay entry. */
  closeOverlay() {
    if (popupSignal() !== "") {
      popupSignal.set("");
      return;
    }
    const top = navOverlay();
    if (top) dropKind(top.kind);
  },
  toggleHelp() {
    if (app.helpOpen()) dropKind("help");
    else app.push("help");
  },
  moveCursor(id: string) {
    cursorIdSignal.set(id);
  },
  /** Opens a message in the reader: the cursor follows. "" closes it. */
  select(id: string) {
    batch(() => {
      selectedIdSignal.set(id);
      cursorIdSignal.set(id);
      if (id === "") {
        dropKind("reader");
        return;
      }
      const stack = navSignal();
      const page = Nav.page(stack).kind;
      if (page !== "list" && page !== "reader") return;
      // Under an overlay the reader goes below it, not over it.
      const overlayAt = stack.findIndex((e) => Nav.isOverlay(e.kind));
      if (overlayAt < 0) {
        setNav(Nav.push(stack, Nav.entry("reader", { id })));
      } else {
        const below = Nav.push(stack.slice(0, overlayAt), Nav.entry("reader", { id }));
        setNav(Nav.copy([...below, ...stack.slice(overlayAt)]));
      }
    });
  },
  /** Back to the list, keeping the cursor and the reader's message. */
  closeReader() {
    dropKind("reader");
  },
  setChecked(ids: string[]) {
    checkedSignal.set(ids);
  },
  clearSelection() {
    batch(() => {
      selectedIdSignal.set("");
      cursorIdSignal.set("");
      checkedSignal.set([]);
      dropKind("reader");
    });
  },
  search(query: string) {
    batch(() => {
      querySignal.set(query);
      if (Nav.page(navSignal()).kind === "reader") dropKind("reader");
    });
  },
  toggleSidebar() {
    sidebarCollapsedSignal.set(!sidebarCollapsedSignal());
  },
  setSidebarCollapsed(collapsed: boolean) {
    sidebarCollapsedSignal.set(collapsed);
  },
  /** One line in the status bar; "" clears it. It clears itself after six
   * seconds, as the Qt client's notice did. */
  setNotice(text: string) {
    noticeSignal.set(text);
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = text === "" ? null : setTimeout(() => {
      noticeTimer = null;
      noticeSignal.set("");
    }, NOTICE_MS);
  },

  // ------------------------------------------------------------- search

  searchFocused: () => searchFocusedSignal(),
  setSearchFocused(focused: boolean) {
    searchFocusedSignal.set(focused);
  },
  /** Asks the search field to take the focus (the `/` key). */
  focusSearch() {
    searchFocusRequestSignal.update((n) => n + 1);
  },
  searchFocusRequests: () => searchFocusRequestSignal(),
};

/** How long a notice stays on the status bar. */
export const NOTICE_MS = 6000;
