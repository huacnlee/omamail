// @ts-nocheck
// Port of omarchy/ui/tests/test_accounts.js: the same cases against the TypeScript module.
import { expect, test } from "nsh/test";
import * as accounts from "./accounts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value === undefined ? null : value));
const eq = (actual: unknown, expected: unknown, _message?: string) => expect(plain(actual)).toEqual(plain(expected));
const neq = (actual: unknown, expected: unknown, _message?: string) => expect(plain(actual)).not.toEqual(plain(expected));
const is = (actual: unknown, expected: unknown, _message?: string) => expect(actual).toBe(expected);
const isNot = (actual: unknown, expected: unknown, _message?: string) => expect(actual).not.toBe(expected);
const ok = (value: unknown, _message?: string) => expect(!!value).toBe(true);

test("accounts matches the Qt rules", () => {


function account(email, extra) {
  return Object.assign({ email: email, clientId: "cid", clientSecret: "secret", label: "" }, extra || {})
}

// A list is only ever handed around, never edited in place, so every check
// below that a mutator left its input alone compares against this snapshot.
function frozen(list) {
  return JSON.stringify(list)
}

// ------------------------------------------------------------------- shape

eq(accounts.emptyList(), { version: accounts.VERSION, accounts: [], activeId: "" })
is(accounts.calendarProvider({ provider: "outlook" }), "microsoft")
is(accounts.calendarProvider({ provider: "imap", email: "person@icloud.com" }), "icloud")
is(accounts.calendarProvider({ provider: "imap", email: "person@example.com",
  imap: { imapHost: "imap.mail.me.com" } }), "icloud",
  "an iCloud custom-domain mailbox is identified by its saved server")
is(accounts.calendarProvider({ provider: "imap", email: "person@example.com",
  imap: { imapHost: "imap.example.com" } }), "")
is(accounts.VERSION, 1)
is(accounts.count(accounts.emptyList()), 0)

// Signed-in state is not account existence. Adding while every saved account
// is signed out must append; only a list made entirely of pending placeholders
// may reuse one instead of creating another row.
is(accounts.hasSavedAccounts({ accounts: [
  { id: "saved@example.com", email: "saved@example.com" }
] }), true)
is(accounts.hasSavedAccounts({ accounts: [
  { id: "", email: "" }
] }), false)
// A non-empty address is not the test. A row holding something that is not an
// address derives no id, so every lookup here treats it as a draft; counting it
// as a saved account is what let `Service.saveAccounts` write a list whose only
// entry was unusable, replacing a working mailbox on disk with a row that could
// not be selected, edited or removed.
is(accounts.hasSavedAccounts({ accounts: [
  { id: "", email: "ada" }
] }), false, "a username in the address field is setup state, not an account")
is(accounts.hasSavedAccounts({ accounts: [
  { id: "", email: "ada" },
  { id: "ada@example.com", email: "ada@example.com" }
] }), true, "one real mailbox alongside it is still a saved list")
is(accounts.active(accounts.emptyList()), null)
is(accounts.find(accounts.emptyList(), "a@example.com"), null)

// --------------------------------------------------------------- addresses

is(accounts.isValidEmail("a@example.com"), true)
is(accounts.isValidEmail("first.last+tag@mail.example.co.uk"), true)
is(accounts.isValidEmail(""), false)
is(accounts.isValidEmail("nobody"), false)
is(accounts.isValidEmail("nobody@example"), false, "a bare host is not an address")
is(accounts.isValidEmail("@example.com"), false)
is(accounts.isValidEmail("two words@example.com"), false)
is(accounts.isValidEmail(null), false)
is(accounts.isValidEmail(undefined), false)

// The id is the address normalised once, because Google echoes the profile
// address back in whatever case the user typed it.
is(accounts.accountId("  Ada@Example.COM "), "ada@example.com")
is(accounts.accountId("nobody"), "")
is(accounts.accountId(""), "")
is(accounts.accountId(null), "")
is(accounts.accountId("Ada@Hotmail.com", "outlook"),
  "outlook:ada@hotmail.com")

// ------------------------------------------------------------------ labels

is(accounts.label({ email: "ada@example.com", label: "Work" }), "Work")
is(accounts.label({ email: "ada@example.com", label: "" }), "ada")
is(accounts.label({ email: "", label: "" }), "New account")
is(accounts.label({ email: "  ", label: "  " }), "New account")
is(accounts.label(null), "New account")
is(accounts.label({ email: "ada@example.com", label: "工作邮箱" }), "工作邮箱")

// --------------------------------------------------------------------- add

let one = accounts.add(accounts.emptyList(), account("Ada@Example.com"))
is(accounts.count(one), 1)
is(one.accounts[0].id, "ada@example.com")
is(one.activeId, "ada@example.com", "the first account is the one on screen")
is(accounts.active(one).id, "ada@example.com")
is(accounts.find(one, "ada@example.com").clientId, "cid")
is(accounts.find(one, "ADA@example.com"), null, "ids are looked up as stored")

const beforeAdd = frozen(one)
let two = accounts.add(one, account("bob@example.com", { label: "Personal" }))
isNot(two, one)
is(frozen(one), beforeAdd, "add leaves its input alone")
is(accounts.count(two), 2)
is(two.activeId, "ada@example.com", "a second account does not steal the selection")

// Re-adding an address is how a wrong client id gets corrected, so it must
// update the entry where it already sits rather than append a twin.
let corrected = accounts.add(two, account("ADA@example.com", { clientId: "cid2", label: "Work" }))
is(accounts.count(corrected), 2)
is(corrected.accounts[0].id, "ada@example.com", "the corrected account keeps its place")
is(corrected.accounts[0].clientId, "cid2")
is(corrected.accounts[0].label, "Work")
is(corrected.accounts[1].id, "bob@example.com")
is(corrected.activeId, "ada@example.com")

// ----------------------------------------------------------------- pending
//
// An account is created before the sign-in that reveals its address, so it
// has to exist with no id — and something with no id is not something the
// window can switch to.

let pending = accounts.add(accounts.emptyList(), account("", { clientId: "cid3" }))
is(accounts.count(pending), 1)
is(pending.accounts[0].id, "")
is(pending.accounts[0].clientId, "cid3")
is(pending.activeId, "", "a pending account cannot be active")
is(accounts.active(pending), null)
is(accounts.find(pending, ""), null, "an empty id names nothing")

// An unusable address is stored as typed and still has no id.
let typo = accounts.add(accounts.emptyList(), account("not-an-address"))
is(typo.accounts[0].id, "")
is(typo.accounts[0].email, "not-an-address")
is(typo.activeId, "")

// Two pending accounts are two accounts: with no id there is nothing to
// de-duplicate them by.
let bothPending = accounts.add(pending, account("", { clientId: "cid4" }))
is(accounts.count(bothPending), 2)
is(bothPending.activeId, "")

// The first account with a real address takes the selection even though it is
// not the first in the list.
let settled = accounts.add(bothPending, account("ada@example.com"))
is(settled.activeId, "ada@example.com")
is(accounts.count(settled), 3)

// ------------------------------------------------------------------ remove

let three = accounts.add(corrected, account("cid@example.com"))
is(accounts.count(three), 3)
const beforeRemove = frozen(three)

// Removing an account is destructive and happens in two steps. The first
// step only describes the target; it never mutates the list. A stale target
// is rejected when the confirmation is finally accepted.
const removal = accounts.removalRequest(three, 0)
eq(removal, {
  id: "ada@example.com",
  email: "ADA@example.com",
  index: 0
})
is(frozen(three), beforeRemove)
is(accounts.removalRequest(three, -1), null)
is(accounts.removalRequest(three, 99), null)
is(accounts.removalRequest(one, 0), null,
  "the only account cannot be removed")
is(accounts.removalRequest(bothPending, 1), null,
  "a draft has no stable identity and is canceled rather than removed")
is(accounts.confirmRemoval(three, { id: "gone@example.com", index: 0 }), -1,
  "confirmation must not remove whichever account later occupies a stale row")
is(accounts.confirmRemoval(three, removal), 0)

let withoutBob = accounts.remove(three, "bob@example.com")
is(frozen(three), beforeRemove, "remove leaves its input alone")
is(accounts.count(withoutBob), 2)
is(accounts.find(withoutBob, "bob@example.com"), null)
is(withoutBob.activeId, "ada@example.com", "removing another account keeps the selection")

// Removing what is on screen has to land somewhere, or the window has nothing
// to show.
let withoutAda = accounts.remove(three, "ada@example.com")
is(accounts.count(withoutAda), 2)
is(accounts.find(withoutAda, withoutAda.activeId) !== null, true)
is(withoutAda.activeId, "bob@example.com")

// The last account leaves nothing to fall back to.
let lastGone = accounts.remove(accounts.remove(withoutAda, "bob@example.com"), "cid@example.com")
is(accounts.count(lastGone), 0)
is(lastGone.activeId, "")
is(accounts.active(lastGone), null)

// The selection never lands on a pending account.
let realAndPending = accounts.add(accounts.add(accounts.emptyList(), account("ada@example.com")), account(""))
is(accounts.remove(realAndPending, "ada@example.com").activeId, "")
is(accounts.count(accounts.remove(realAndPending, "ada@example.com")), 1)

// An id nobody has, and the empty id a pending row would hand over, must not
// take anything out with them.
eq(accounts.remove(three, "nobody@example.com"), three)
eq(accounts.remove(realAndPending, ""), realAndPending, "an empty id must not sweep out every pending row")
isNot(accounts.remove(three, "nobody@example.com"), three)

// --------------------------------------------------------------- setActive

const beforeSet = frozen(three)
let switched = accounts.setActive(three, "cid@example.com")
is(frozen(three), beforeSet, "setActive leaves its input alone")
is(switched.activeId, "cid@example.com")
is(accounts.active(switched).id, "cid@example.com")
is(accounts.count(switched), 3)

// A stale id means the caller is acting on a list that has moved on. Showing
// no mailbox at all is worse than still showing the previous one.
eq(accounts.setActive(three, "nobody@example.com"), three)
eq(accounts.setActive(three, ""), three)
eq(accounts.setActive(realAndPending, ""), realAndPending)

// ------------------------------------------------------------------- load

eq(accounts.load(""), accounts.emptyList())
eq(accounts.load("{not json"), accounts.emptyList())
eq(accounts.load("[]"), accounts.emptyList(), "an array is not a list of accounts")
eq(accounts.load("null"), accounts.emptyList())
eq(accounts.load(null), accounts.emptyList())
is(accounts.isSerializedList(""), false)
is(accounts.isSerializedList("{not json"), false)
is(accounts.isSerializedList(JSON.stringify({
  version: accounts.VERSION, accounts: []
})), true, "a real empty first-run file is distinguishable from a failed read")
is(accounts.isSerializedList(JSON.stringify({
  version: accounts.VERSION + 1, accounts: []
})), false, "a newer format must not be mistaken for this build's list")
eq(accounts.load(JSON.stringify({ accounts: [] })), accounts.emptyList(), "no version at all")
eq(accounts.load(JSON.stringify({
  version: accounts.VERSION + 99,
  accounts: [{ id: "ada@example.com", email: "ada@example.com" }],
  activeId: "ada@example.com"
})), accounts.emptyList(), "a newer format is discarded rather than half-read")
eq(accounts.load(JSON.stringify({ version: accounts.VERSION, accounts: "nope", activeId: "x" })),
  accounts.emptyList(), "accounts that is not an array")

// A selection naming an account that is not in the file — hand-edited, or
// removed while the window was closed — must not leave the window blank.
const repaired = accounts.load(JSON.stringify({
  version: accounts.VERSION,
  accounts: [{ email: "ada@example.com" }, { email: "bob@example.com" }],
  activeId: "gone@example.com"
}))
is(repaired.activeId, "ada@example.com")
is(repaired.accounts[0].id, "ada@example.com", "the id is recomputed from the address")

// A file listing only pending accounts has nothing to select.
const pendingFile = accounts.load(JSON.stringify({
  version: accounts.VERSION, accounts: [{ email: "" }], activeId: "ada@example.com"
}))
is(accounts.count(pendingFile), 1)
is(pendingFile.activeId, "")

// Junk among the entries is skipped rather than stored as an account nobody
// can click.
const messy = accounts.load(JSON.stringify({
  version: accounts.VERSION,
  accounts: [null, "ada@example.com", { email: "bob@example.com" }, 7],
  activeId: "bob@example.com"
}))
is(accounts.count(messy), 1)
is(messy.activeId, "bob@example.com")

// -------------------------------------------------------------- round trip

let saved = accounts.emptyList()
saved = accounts.add(saved, account("ada@example.com", { label: "工作邮箱" }))
saved = accounts.add(saved, account("bob@example.com", { label: "Personal" }))
saved = accounts.add(saved, account("", { clientId: "cid5", pending: true }))
saved = accounts.setActive(saved, "bob@example.com")

const text = accounts.serialize(saved)
// The file crosses a line-oriented pipe on its way to disk, so a newline
// anywhere in it truncates the list.
is(text.indexOf("\n"), -1, "serialize must produce a single line")
is(accounts.serialize(accounts.emptyList()).indexOf("\n"), -1)

const reloaded = accounts.load(text)
eq(reloaded, saved, "order, ids and the selection all survive")
is(reloaded.activeId, "bob@example.com")
is(accounts.label(reloaded.accounts[0]), "工作邮箱", "non-ASCII labels survive")
is(accounts.count(reloaded), 3)

// A label with a newline in it is still one line on disk.
const multiline = accounts.serialize(accounts.add(accounts.emptyList(), account("ada@example.com", { label: "a\nb" })))
is(multiline.indexOf("\n"), -1)
is(accounts.load(multiline).accounts[0].label, "a\nb")

// ------------------------------------------------------ repairing an address
//
// The IMAP form used to save whatever the address field held, unchecked. A
// username typed there became the row's address, and since the id is derived
// from the address the row stopped being addressable: it could not be
// selected, signed, switched to or removed, and the next write dropped it.
//
// The address was never actually lost. `setupSettings` folds the address into
// the username when no separate one was given, so `imap.username` still holds
// it — and a row that can be repaired is repaired on the way in.
const damaged = JSON.stringify({ version: accounts.VERSION, accounts: [{
  email: "ada", provider: "imap", imap: {
    imapHost: "imap.example.org", smtpHost: "smtp.example.org",
    username: "ada@example.org" } }], activeId: "" })
const mended = accounts.load(damaged)
is(mended.accounts[0].email, "ada@example.org",
  "the address comes back from the username it was folded into")
is(mended.accounts[0].id, "imap:ada@example.org")
is(mended.activeId, "imap:ada@example.org", "and the row is selectable again")
is(mended.accounts[0].imap.imapHost, "imap.example.org",
  "everything else about the row is untouched")

// Only where there is an address to adopt. A username that is not one leaves
// the row exactly as unusable as it was — better than inventing something.
const unfixable = accounts.load(JSON.stringify({ version: accounts.VERSION, accounts: [{
  email: "ada", provider: "imap", imap: { imapHost: "imap.example.org", username: "ada" } }],
  activeId: "" }))
is(unfixable.accounts[0].email, "ada")
is(unfixable.accounts[0].id, "")

// A Gmail row has no username to adopt, and one that turned up there would not
// be an address this may act on.
const gmailRow = accounts.load(JSON.stringify({ version: accounts.VERSION, accounts: [{
  email: "ada", provider: "gmail", imap: { username: "ada@example.org" } }], activeId: "" }))
is(gmailRow.accounts[0].email, "ada")

// And not while the form is open: `add` must never adopt a username, or typing
// one into the servers section would fill in an address nobody asked for.
const typing = accounts.add(accounts.emptyList(),
  { email: "", provider: "imap", imap: { username: "ada@example.org" }, pending: true })
is(typing.accounts[0].email, "", "a row being typed into invents nothing")

// A real address makes a row a mailbox whatever the flag says, because
// `configureAccount` copies every key of the row it edits and a flag that had
// to be cleared by hand would have outlived setup.
const configured = accounts.add(accounts.emptyList(),
  { email: "ada@example.org", provider: "imap", pending: true })
is(configured.accounts[0].pending, false)

// The whole sequence, as it happened: a corrupted mailbox on disk, then an
// unrelated account added. It was that second step that satisfied the old
// list-wide guard and let the write through with the first row missing.
let recovered = accounts.load(damaged)
recovered = accounts.add(recovered, account("bob@example.com"))
const payload = accounts.savedOnly(recovered)
is(accounts.count(payload), 2, "adding one mailbox must not delete another")
eq(payload.accounts.map(a => a.email), ["ada@example.org", "bob@example.com"])
is(accounts.dropsNamedMailbox(recovered, payload), false)

// -------------------------------------------------------------- what is written
//
// The row `add` creates before anything has been typed into it is the setup
// form's working state, not a mailbox, and it says so — `pending`. Any save
// used to carry whichever draft happened to be open along with it, leaving a
// "New mailbox" on disk that nothing could select and nothing could remove.
const withDraft = accounts.savedOnly(saved)
is(accounts.count(saved), 3, "savedOnly leaves its input alone")
is(accounts.count(withDraft), 2, "the draft row is not written")
eq(withDraft.accounts.map(a => a.id), ["ada@example.com", "bob@example.com"])
is(withDraft.activeId, "bob@example.com", "the selection is kept")
is(accounts.draftCount(saved), 1)

// A draft is a row that says it is one. Inferring it from a missing id read a
// mailbox whose address had been corrupted as working state and dropped it
// here — which is how adding one mailbox deleted a different, working one.
// This row has no id either, and it is not a draft: its servers were typed in
// and its password is in the keyring.
let broken = accounts.emptyList()
broken = accounts.add(broken, account("ada@example.com"))
broken = accounts.add(broken, account("ada", { provider: "imap",
  imap: { imapHost: "imap.example.org", username: "ada" } }))
is(accounts.count(accounts.savedOnly(broken)), 2,
  "a mailbox with an unusable address is kept, not quietly deleted")
is(accounts.draftCount(broken), 0)

// A row holding nothing at all is a different thing: the leftover of an Add
// nobody filled in, and there is nothing in one to preserve.
let hollow = accounts.emptyList()
hollow = accounts.add(hollow, account("ada@example.com"))
hollow = accounts.add(hollow, { email: "" })
is(accounts.count(accounts.savedOnly(hollow)), 1)
is(accounts.carriesData({ email: "", imap: {} }), false)
ok(accounts.carriesData({ id: "", imap: { username: "ada@example.org" } }))

// Nothing may drop a mailbox the list can name. The guard this replaces asked
// only whether the payload still held *some* mailbox, which one freshly added
// account was enough to satisfy.
ok(accounts.dropsNamedMailbox(broken, accounts.emptyList()))
is(accounts.dropsNamedMailbox(saved, accounts.savedOnly(saved)), false)
is(accounts.dropsNamedMailbox(broken, accounts.savedOnly(broken)), false)

// The selection follows when the row it named is the one dropped.
let activeDraft = accounts.add(accounts.emptyList(), account("ada@example.com"))
activeDraft = accounts.add(activeDraft, account(""))
activeDraft.activeId = ""
is(accounts.savedOnly(activeDraft).activeId, "ada@example.com",
  "a list written with no selection still names a mailbox")

// Nothing to keep is left empty rather than invented; the write guard in
// Service.saveAccounts is what stops that reaching disk.
is(accounts.count(accounts.savedOnly(
  accounts.add(accounts.emptyList(), { email: "", pending: true }))), 0)
is(accounts.serialize(accounts.savedOnly(saved)).indexOf("\n"), -1)

// An idless row is not necessarily the setup form's draft. A legacy mailbox
// whose address cannot be repaired is deliberately kept by `savedOnly`, and
// cancelling a draft must not become a second path that silently deletes it.
const damagedDraftLookalike = accounts.add(accounts.emptyList(), {
  email: "ada", provider: "imap",
  imap: { imapHost: "imap.example.org", username: "ada" }
})
is(accounts.count(accounts.discardDraftAt(damagedDraftLookalike, 0)), 1,
  "only a row marked pending may be discarded as a draft")

// ------------------------------------------------------- removing by index
//
// A pending account has no id, so nothing can name it — and a sign-in that
// failed half way leaves exactly that. Position is the only handle the window
// has on one.

let pendingList = accounts.emptyList()
pendingList = accounts.add(pendingList, { email: "one@example.com", clientId: "c1" })
pendingList = accounts.add(pendingList, { email: "", clientId: "c2", pending: true })
pendingList = accounts.add(pendingList, { email: "two@example.com", clientId: "c3" })
is(accounts.count(pendingList), 3)

const withoutPending = accounts.removeAt(pendingList, 1)
is(accounts.count(withoutPending), 2)
is(withoutPending.accounts[1].email, "two@example.com")
is(accounts.count(pendingList), 3, "the input is left alone")

// Removing the active account by index hands the selection on, exactly as
// removing it by id does.
const activeGone = accounts.removeAt(withoutPending, 0)
is(accounts.count(activeGone), 1)
is(activeGone.activeId, "two@example.com")

// Out of range is inert rather than destructive.
is(accounts.count(accounts.removeAt(pendingList, 99)), 3)
is(accounts.count(accounts.removeAt(pendingList, -1)), 3)
is(accounts.count(accounts.removeAt(pendingList, "nonsense")), 3)

// Cancelling Add removes only the unnamed draft. Once an address has been
// saved, Back is navigation and must not delete the account.
is(accounts.count(accounts.discardDraftAt(pendingList, 1)), 2)
is(accounts.count(accounts.discardDraftAt(pendingList, 0)), 3)

// ---------------------------------------------------------------- providers
//
// A mailbox is Gmail, IMAP, or HEY. The rules that matter are what an upgrade
// does to accounts written before providers existed, and what happens when one
// address is reached two different ways.

{
  // Anything unrecognised — an empty field, a newer build's name, a hand edit —
  // is Gmail, because that is what every account in an upgraded install is.
  is(accounts.makeAccount({ email: "jane@gmail.com" }).provider, "gmail")
  is(accounts.makeAccount({ email: "j@x.com", provider: "" }).provider, "gmail")
  is(accounts.makeAccount({ email: "j@x.com", provider: "pigeon" }).provider, "gmail")
  is(accounts.makeAccount({ email: "j@x.com", provider: "IMAP" }).provider, "imap")
  is(accounts.makeAccount({ email: "j@x.com", provider: " hey " }).provider, "hey")

  // A Gmail account keeps the bare address as its id, so nothing already on
  // disk — its cache directory, its keyring entry, the activeId in the file —
  // needs migrating when this build first runs.
  is(accounts.makeAccount({ email: "Jane@Gmail.com" }).id, "jane@gmail.com")
  is(
    accounts.makeAccount({ email: "jane@fastmail.com", provider: "imap" }).id,
    "imap:jane@fastmail.com")

  // The same address reached two ways is two mailboxes, not one overwriting
  // the other.
  let list = accounts.emptyList()
  list = accounts.add(list, { email: "jane@gmail.com", provider: "gmail" })
  list = accounts.add(list, { email: "jane@gmail.com", provider: "imap" })
  is(accounts.count(list), 2,
    "one address over two providers is two accounts")
  is(accounts.find(list, "jane@gmail.com").provider, "gmail")
  is(accounts.find(list, "imap:jane@gmail.com").provider, "imap")

  // Re-adding the same one still replaces in place rather than appending.
  list = accounts.add(list, { email: "jane@gmail.com", provider: "imap", label: "Work" })
  is(accounts.count(list), 2)
  is(accounts.find(list, "imap:jane@gmail.com").label, "Work")

  // Saving Proton's address onto the iCloud row, when Proton already exists,
  // used to rebuild the list with `add` and silently drop iCloud: the new id
  // collided and replaced the Proton row, and the original slot was gone.
  // `replaceAt` must refuse that collision so a re-auth cannot delete a
  // mailbox that was not being edited.
  let icloud = {
    email: "ada@icloud.com", provider: "imap", label: "iCloud",
    imap: { imapHost: "imap.mail.me.com", username: "ada" }
  }
  let proton = {
    email: "ada@proton.me", provider: "imap", label: "Proton",
    imap: { imapHost: "127.0.0.1", imapPort: 1143, smtpPort: 1025, insecure: true }
  }
  let mailboxes = accounts.emptyList()
  mailboxes = accounts.add(mailboxes, icloud)
  mailboxes = accounts.add(mailboxes, proton)
  mailboxes = accounts.add(mailboxes, { email: "ada@gmail.com", provider: "imap", label: "Gmail" })
  is(accounts.collidingId(mailboxes, 0, proton), "imap:ada@proton.me")
  const refused = accounts.replaceAt(mailboxes, 0, proton)
  is(accounts.count(refused), 3, "a colliding save must not drop a row")
  is(accounts.find(refused, "imap:ada@icloud.com").label, "iCloud")
  is(accounts.find(refused, "imap:ada@proton.me").label, "Proton")

  // Filling a new draft with an address that is not already in the list is
  // not a collision — that is Add account.
  let adding = accounts.emptyList()
  adding = accounts.add(adding, icloud)
  adding = accounts.add(adding, { email: "ada@gmail.com", provider: "imap", label: "Gmail" })
  adding = accounts.add(adding, { email: "", provider: "imap", pending: true })
  is(accounts.collidingId(adding, 2, proton), "")
  const filled = accounts.replaceAt(adding, 2, proton)
  is(accounts.count(filled), 3)
  is(accounts.find(filled, "imap:ada@icloud.com").label, "iCloud")
  is(filled.accounts[2].id, "imap:ada@proton.me")

  // A write that omits an id that was already persisted is the disk form of
  // the same bug. Removal goes through `remove`, so save must refuse this.
  const persisted = accounts.namedIds(mailboxes)
  const withoutIcloud = accounts.savedOnly(accounts.remove(mailboxes, "imap:ada@icloud.com"))
  ok(accounts.dropsAnyId(persisted, withoutIcloud),
    "a payload missing a persisted id is a drop")
  is(accounts.dropsAnyId(persisted, accounts.savedOnly(mailboxes)), false)
  is(accounts.withoutId(["a", "b", "c"], "b").join(","), "a,c",
    "a corrected address releases the old id on purpose")
  is(accounts.withoutId(null, "b").length, 0)

  // Removing one leaves the other.
  list = accounts.remove(list, "imap:jane@gmail.com")
  is(accounts.count(list), 1)
  is(accounts.find(list, "jane@gmail.com").provider, "gmail")
}

// ------------------------------------------------------------ IMAP settings
//
// Not secret — the password is, and that lives in the keyring — so these ride
// on the account and survive the round trip through the file.

{
  const saved = accounts.serialize(accounts.add(accounts.emptyList(), {
    email: "jane@fastmail.com",
    provider: "imap",
    imap: {
      imapHost: "imap.fastmail.com", imapPort: 993,
      smtpHost: "smtp.fastmail.com", smtpPort: 465,
      username: "jane@fastmail.com",
      aliases: "alias@fastmail.com (default), work@domain.com"
    }
  }))
  const reloaded = accounts.find(accounts.load(saved), "imap:jane@fastmail.com")
  is(reloaded.provider, "imap")
  is(reloaded.imap.imapHost, "imap.fastmail.com")
  is(reloaded.imap.smtpPort, 465)
  is(reloaded.imap.username, "jane@fastmail.com")
  is(reloaded.imap.aliases.length, 2)
  is(reloaded.imap.aliases[0].email, "alias@fastmail.com")
  is(reloaded.imap.aliases[0].isDefault, true)
  is(reloaded.imap.aliases[1].isDefault, false)
  is(reloaded.imap.insecure, false)

  // Ports out of range fall back rather than reaching a URL.
  const clamped = accounts.makeAccount({
    email: "j@x.com", provider: "imap",
    imap: { imapPort: 0, smtpPort: 999999 }
  })
  is(clamped.imap.imapPort, 993)
  is(clamped.imap.smtpPort, 465)

  // A Gmail account still serialises without IMAP settings meaning anything.
  const gmail = accounts.makeAccount({ email: "j@gmail.com", clientId: "abc" })
  is(gmail.imap.imapHost, "")
  is(gmail.clientId, "abc")

  // An accounts.json written by the previous build has no provider field at
  // all, and every account in it must come back as a working Gmail account.
  const legacy = accounts.load(JSON.stringify({
    version: 1,
    accounts: [{ id: "jane@gmail.com", email: "jane@gmail.com", clientId: "abc" }],
    activeId: "jane@gmail.com"
  }))
  is(accounts.count(legacy), 1)
  is(legacy.activeId, "jane@gmail.com",
    "the active account is still the one the user was looking at")
  is(accounts.active(legacy).provider, "gmail")
  is(accounts.active(legacy).clientId, "abc")
}

// ------------------------------------------------------------ JMAP settings
//
// Four fields, and only one of them was typed. The rest are what sign-in
// learned: the URL that finally answered, the scheme that was accepted, and
// the account id the server's `primaryAccounts` named.

{
  const saved = accounts.serialize(accounts.add(accounts.emptyList(), {
    email: "ada@example.org",
    provider: "jmap",
    jmap: {
      sessionUrl: "https://mail.example.org/jmap/session",
      username: "ada",
      authScheme: "basic",
      accountId: "t"
    }
  }))
  const reloaded = accounts.find(accounts.load(saved), "jmap:ada@example.org")
  is(reloaded.provider, "jmap")
  is(reloaded.id, "jmap:ada@example.org",
    "one address can be an IMAP mailbox and a JMAP one at the same time")
  is(reloaded.jmap.sessionUrl, "https://mail.example.org/jmap/session")
  is(reloaded.jmap.username, "ada")
  is(reloaded.jmap.authScheme, "basic")
  is(reloaded.jmap.accountId, "t")

  // The secret is not here and never was: it goes to the keyring under
  // `Credentials.jmapKeyringAttributes`, and accounts.json is world-readable.
  ok(saved.indexOf("secret") < 0)
  ok(saved.indexOf("password") < 0)

  // Bearer is recorded when that is what answered.
  is(accounts.makeAccount({
    email: "ada@fastmail.com", provider: "jmap", jmap: { authScheme: " Bearer " }
  }).jmap.authScheme, "bearer")

  // Anything else is Basic: an account that has not signed in yet has no
  // scheme at all, and Basic is the one sign-in tries first. `none` is
  // discovery's unauthenticated GET, which is not a way of signing in.
  is(accounts.makeAccount({ email: "ada@x.com", provider: "jmap" })
    .jmap.authScheme, "basic")
  is(accounts.makeAccount({
    email: "ada@x.com", provider: "jmap", jmap: { authScheme: "none" }
  }).jmap.authScheme, "basic")
  is(accounts.makeAccount({
    email: "ada@x.com", provider: "jmap", jmap: { authScheme: "digest" }
  }).jmap.authScheme, "basic")

  // A JMAP block is present on every account, so nothing has to guard an
  // undefined one, and an account of another provider has an empty one.
  const gmail = accounts.makeAccount({ email: "j@gmail.com", clientId: "abc" })
  is(gmail.jmap.sessionUrl, "")
  is(gmail.jmap.accountId, "")

  // `jmap` is a provider a hand-edited or newer file may name, and it survives
  // the round trip rather than reading as Gmail.
  is(accounts.makeAccount({ email: "j@x.com", provider: "JMAP" }).provider, "jmap")
  is(accounts.makeAccount({ email: "j@x.com", provider: " jmap " }).provider, "jmap")

  // The same address over three providers is three mailboxes.
  let list = accounts.emptyList()
  list = accounts.add(list, { email: "ada@example.org", provider: "imap" })
  list = accounts.add(list, { email: "ada@example.org", provider: "jmap" })
  is(accounts.count(list), 2)
  is(accounts.find(list, "jmap:ada@example.org").provider, "jmap")
  is(accounts.find(list, "imap:ada@example.org").provider, "imap")
}

// What sign-in learned, over what the page saved. The page can only write the
// typed host and the username; the URL that answered, the scheme and the
// account id exist only once the check has run, and an account that never
// receives them can never be configured — which is the defect this covers.
{
  const typed = { sessionUrl: "mail.example.org", username: "jane", authScheme: "", accountId: "" }
  const learned = accounts.jmapSettingsAfterSignIn(typed, {
    sessionUrl: "https://mx.example.org/jmap/session", authScheme: "bearer",
    accountId: "a1", canSend: true, mailboxCount: 5
  })
  eq(learned, {
    sessionUrl: "https://mx.example.org/jmap/session", username: "jane",
    authScheme: "bearer", accountId: "a1"
  }, "the three learned fields land and the typed username stays")
  eq(accounts.jmapSettingsAfterSignIn(learned, { sessionUrl: "", accountId: "" }),
    learned, "a result short a field keeps the value already there")
  eq(accounts.jmapSettingsAfterSignIn(null, null),
    { sessionUrl: "", username: "", authScheme: "basic", accountId: "" },
    "nothing learned over nothing saved is the empty, Basic default")
  eq(accounts.jmapSettingsAfterSignIn(typed, { authScheme: "digest" }).authScheme,
    "basic", "an unknown scheme is normalised the way the file's own is")
}

// ------------------------------------------------------------- signatures

{
  // Absent is empty, so an account written before the field existed loads with
  // a signature rather than an undefined one every caller has to guard.
  is(accounts.makeAccount({ email: "j@gmail.com" }).signature, "")
  is(accounts.makeAccount({
    email: "j@gmail.com", signature: "  Maarten\nmadra.nl  "
  }).signature, "Maarten\nmadra.nl", "the ends are trimmed, the middle is not")

  const list = accounts.add(accounts.emptyList(), account("jane@gmail.com"))
  const before = frozen(list)

  const signed = accounts.setSignature(list, "jane@gmail.com", "Jane\nRoe")
  is(accounts.find(signed, "jane@gmail.com").signature, "Jane\nRoe")
  is(frozen(list), before, "the list handed in is not edited")

  // Setting one must not disturb the rest of the entry, which is the whole
  // account: a signature edit that dropped an OAuth client would sign the user
  // out to save a sign-off.
  const entry = accounts.find(signed, "jane@gmail.com")
  is(entry.clientId, "cid")
  is(entry.clientSecret, "secret")
  is(entry.provider, "gmail")
  is(signed.activeId, "jane@gmail.com")

  // Clearing is setting it to nothing, not a second operation.
  is(accounts.find(accounts.setSignature(signed, "jane@gmail.com", ""),
    "jane@gmail.com").signature, "")

  // An id the list does not hold is a caller acting on a list that has moved
  // on — the same rule the other mutators follow, so it changes nothing.
  is(frozen(accounts.setSignature(list, "nobody@gmail.com", "x")), before)
  is(frozen(accounts.setSignature(list, "", "x")), before)

  // A signature is the one field here that legitimately contains newlines, and
  // the file crosses a line-oriented pipe on the way to disk. JSON escaping is
  // what keeps a two-line sign-off from truncating the account list.
  const stored = accounts.serialize(signed)
  ok(stored.indexOf("\n") < 0, "no raw newline reaches the writer")
  const reloaded = accounts.load(stored)
  is(accounts.find(reloaded, "jane@gmail.com").signature, "Jane\nRoe",
    "what was typed comes back")

  // Two mailboxes are two identities. Signing one must leave the other unsigned.
  const both = accounts.add(signed, account("john@gmail.com"))
  is(accounts.find(both, "john@gmail.com").signature, "")
  is(accounts.find(both, "jane@gmail.com").signature, "Jane\nRoe")
}


// ------------------------------------------------------------- the name

// Two mailboxes can differ only in their domain and elide to the same handful
// of characters in a list, so a name is the one thing that tells them apart.
const named = accounts.setLabel(
  accounts.add(accounts.emptyList(), { email: "me@gmail.com", provider: "gmail" }),
  "me@gmail.com", "  Private  ")
is(named.accounts[0].label, "Private", "trimmed on the way in")
is(accounts.label(named.accounts[0]), "Private")

// Empty is not a name and clears it, which puts the address back: `label`
// falls through to the local part, so a mailbox is never left unnamed.
const cleared = accounts.setLabel(named, "me@gmail.com", "   ")
is(cleared.accounts[0].label, "")
is(accounts.label(cleared.accounts[0]), "me")

// Naming a mailbox that is not in the list changes nothing rather than adding
// one, the way every other edit here behaves.
is(
  accounts.serialize(accounts.setLabel(named, "nobody@example.org", "Ghost")),
  accounts.serialize(named))

// The rest of the entry survives, because the row is rebuilt rather than
// patched and a field added later must not drop one added earlier.
const withBoth = accounts.setSignature(named, "me@gmail.com", "Best, me")
is(withBoth.accounts[0].label, "Private")
is(withBoth.accounts[0].signature, "Best, me")
is(
  accounts.setLabel(withBoth, "me@gmail.com", "Personal").accounts[0].signature,
  "Best, me", "naming a mailbox does not forget its signature")

// ---------------------------------------------------------------- replaceAt

// Editing a row leaves the selection where it was. The rebuild passes through
// `add`, whose rule for a list with no active row yet is "the first named row
// is the one on screen" — right while a list is being built, and wrong while
// one is being copied with its active row further down. Editing the second
// mailbox used to hand the selection to the first, and the sign-in after the
// save with it.
const trio = accounts.add(accounts.add(accounts.add(accounts.emptyList(),
  account("ada@example.com")),
  account("bob@example.com", { provider: "imap" })),
  account("cid@example.com", { provider: "jmap" }))
const bobActive = accounts.setActive(trio, "imap:bob@example.com")
const cidActive = accounts.setActive(trio, "jmap:cid@example.com")
const beforeReplace = frozen(cidActive)

const cidEdited = accounts.replaceAt(cidActive, 2,
  Object.assign({}, cidActive.accounts[2], { jmap: { sessionUrl: "https://mail.example.com/jmap/session" } }))
is(frozen(cidActive), beforeReplace, "replaceAt leaves its input alone")
is(accounts.count(cidEdited), 3)
is(cidEdited.activeId, "jmap:cid@example.com",
  "editing the active row keeps it active")
is(cidEdited.accounts[2].jmap.sessionUrl, "https://mail.example.com/jmap/session")
is(cidEdited.accounts[2].provider, "jmap", "and keeps the rest of the row")

const adaEditedUnderCid = accounts.replaceAt(cidActive, 0,
  Object.assign({}, cidActive.accounts[0], { label: "Work" }))
is(adaEditedUnderCid.activeId, "jmap:cid@example.com",
  "editing another row does not move the selection to it")
is(adaEditedUnderCid.accounts[0].label, "Work")

const bobEditedUnderCid = accounts.replaceAt(cidActive, 1,
  Object.assign({}, cidActive.accounts[1], { label: "Home" }))
is(bobEditedUnderCid.activeId, "jmap:cid@example.com",
  "nor to the first row, whichever row was edited")

// The active row renamed follows its new id: the mailbox on screen is still
// the one being edited, whatever it is now called.
const bobRenamed = accounts.replaceAt(bobActive, 1,
  Object.assign({}, bobActive.accounts[1], { email: "robert@example.com" }))
is(bobRenamed.accounts[1].id, "imap:robert@example.com")
is(bobRenamed.activeId, "imap:robert@example.com")

// A row edited to name a mailbox already in the list is refused rather than
// folded into it: `add` folding a re-added address is right for a list being
// built, and wrong for an edit, where the fold deleted the other mailbox. The
// list, and the selection, are left exactly as they were; the service says
// why (`duplicateAccount`) from `collidingId`.
const collision = Object.assign({}, cidActive.accounts[1], { email: "ada@example.com", provider: "gmail" })
is(accounts.collidingId(cidActive, 1, collision), "ada@example.com")
const refusedEdit = accounts.replaceAt(cidActive, 1, collision)
is(accounts.count(refusedEdit), 3)
is(refusedEdit.accounts[0].id, "ada@example.com")
is(refusedEdit.accounts[1].id, "imap:bob@example.com")
is(refusedEdit.activeId, "jmap:cid@example.com")

// A draft that gains its address while another row is active leaves that row
// active: a mailbox being typed in is not the one on screen until the
// service says so.
const draftBeside = accounts.add(bobActive, { email: "", pending: true })
is(draftBeside.activeId, "imap:bob@example.com")
const draftNamed = accounts.replaceAt(draftBeside, 3,
  Object.assign({}, draftBeside.accounts[3], { email: "dee@example.com", provider: "imap" }))
is(draftNamed.accounts[3].id, "imap:dee@example.com")
is(draftNamed.activeId, "imap:bob@example.com")

// With nothing active, the first named row takes the selection, which is the
// rule a list being built already has.
const nothingActive = accounts.replaceAt(
  { version: accounts.VERSION, accounts: [{ id: "", email: "", provider: "gmail", pending: true }], activeId: "" },
  0, { email: "eve@example.com" })
is(nothingActive.activeId, "eve@example.com")

// Out of range is no edit.
is(frozen(accounts.replaceAt(cidActive, 3, account("x@example.com"))), beforeReplace)
is(frozen(accounts.replaceAt(cidActive, -1, account("x@example.com"))), beforeReplace)
// Monitored labels ride with the mailbox and survive its other edits.
{
  const watched = accounts.toggleMonitored(named, "me@gmail.com", "Label_7")
  eq(watched.accounts[0].monitored, ["Label_7"])
  eq(accounts.toggleMonitored(watched, "me@gmail.com", "Label_7").accounts[0].monitored, [],
    "toggling again stops watching")
  const two = accounts.toggleMonitored(watched, "me@gmail.com", "Label_9")
  eq(two.accounts[0].monitored, ["Label_7", "Label_9"])
  eq(accounts.setLabel(two, "me@gmail.com", "Work").accounts[0].monitored, ["Label_7", "Label_9"],
    "naming the mailbox keeps what it watches")
  eq(accounts.toggleMonitored(two, "nobody@example.org", "x").accounts[0].monitored, ["Label_7", "Label_9"])
  eq(accounts.toggleMonitored(two, "me@gmail.com", "  ").accounts[0].monitored, ["Label_7", "Label_9"])
  eq(accounts.load(accounts.serialize(two)).accounts[0].monitored, ["Label_7", "Label_9"],
    "and it is written to disk and read back")
  // (The Qt test also fed a QML sequence here; TSX has no such values.)
  eq(accounts.setMonitored(two, "me@gmail.com", ["Label_8"]).accounts[0].monitored, ["Label_8"])
  eq(accounts.setMonitored(two, "me@gmail.com", "Label_8").accounts[0].monitored, [],
    "a string is not a list")
}


// An HTML signature sits beside the plain one and survives its edits.
{
  const rich = accounts.setSignatureHtml(named, "me@gmail.com", " <p>Ada</p> ")
  is(rich.accounts[0].signatureHtml, "<p>Ada</p>")
  is(accounts.setSignature(rich, "me@gmail.com", "Ada").accounts[0].signatureHtml, "<p>Ada</p>")
  is(accounts.setSignatureHtml(rich, "me@gmail.com", "").accounts[0].signatureHtml, "")
  is(accounts.load(accounts.serialize(rich)).accounts[0].signatureHtml, "<p>Ada</p>")
}

// ------------------------------------------------------------ sender name

// The name recipients see beside an IMAP or Outlook mailbox's address. It is
// stored on the entry, so it has to survive the rebuild every write does.
{
  const imap = accounts.add(accounts.emptyList(),
    { email: "me@example.org", provider: "imap", imap: { username: "me@example.org" } })
  const id = imap.accounts[0].id
  is(imap.accounts[0].senderName, "", "no name until one is given")

  const named = accounts.setSenderName(imap, id, "  Jane   Example ")
  is(named.accounts[0].senderName, "Jane Example")
  is(frozen(imap), frozen(accounts.add(accounts.emptyList(),
    { email: "me@example.org", provider: "imap", imap: { username: "me@example.org" } })),
    "the input list is left alone")
  is(accounts.load(accounts.serialize(named)).accounts[0].senderName, "Jane Example",
    "a saved name comes back from the file")
  is(accounts.setLabel(named, id, "Personal").accounts[0].senderName, "Jane Example",
    "naming the mailbox does not forget the sender name")
  is(accounts.setSenderName(named, id, "   ").accounts[0].senderName, "",
    "empty clears it, so the address goes out alone")

  // One header line: a pasted break or tab becomes a space, never a header
  // the send would refuse.
  is(accounts.senderNameText("Jane\r\nExample\t\u0007"), "Jane Example")
is(accounts.senderNameText("Jane\u0085Example\u009f"), "Jane Example",
  "a C1 control is a control too, and the backend refuses a name with one")
}

// Only the mailboxes with no server to name the sender take it from here.
is(accounts.namesSender("imap"), true)
is(accounts.namesSender("outlook"), true)
is(accounts.namesSender("gmail"), false)
is(accounts.namesSender("jmap"), false)
is(accounts.namesSender("hey"), false)
is(accounts.namesSender(undefined), false)

});
