const assert = require("assert")
const { load, deepEqual } = require("./load")

const accounts = load("account/Accounts.js")

function account(email, extra) {
  return Object.assign({ email: email, clientId: "cid", clientSecret: "secret", label: "" }, extra || {})
}

// A list is only ever handed around, never edited in place, so every check
// below that a mutator left its input alone compares against this snapshot.
function frozen(list) {
  return JSON.stringify(list)
}

// ------------------------------------------------------------------- shape

deepEqual(accounts.emptyList(), { version: accounts.VERSION, accounts: [], activeId: "" })
assert.strictEqual(accounts.VERSION, 1)
assert.strictEqual(accounts.count(accounts.emptyList()), 0)

// Signed-in state is not account existence. Adding while every saved account
// is signed out must append; only a list made entirely of pending placeholders
// may reuse one instead of creating another row.
assert.strictEqual(accounts.hasSavedAccounts({ accounts: [
  { id: "saved@example.com", email: "saved@example.com" }
] }), true)
assert.strictEqual(accounts.hasSavedAccounts({ accounts: [
  { id: "", email: "" }
] }), false)
// A non-empty address is not the test. A row holding something that is not an
// address derives no id, so every lookup here treats it as a draft; counting it
// as a saved account is what let `Service.saveAccounts` write a list whose only
// entry was unusable, replacing a working mailbox on disk with a row that could
// not be selected, edited or removed.
assert.strictEqual(accounts.hasSavedAccounts({ accounts: [
  { id: "", email: "ada" }
] }), false, "a username in the address field is setup state, not an account")
assert.strictEqual(accounts.hasSavedAccounts({ accounts: [
  { id: "", email: "ada" },
  { id: "ada@example.com", email: "ada@example.com" }
] }), true, "one real mailbox alongside it is still a saved list")
assert.strictEqual(accounts.active(accounts.emptyList()), null)
assert.strictEqual(accounts.find(accounts.emptyList(), "a@example.com"), null)

// --------------------------------------------------------------- addresses

assert.strictEqual(accounts.isValidEmail("a@example.com"), true)
assert.strictEqual(accounts.isValidEmail("first.last+tag@mail.example.co.uk"), true)
assert.strictEqual(accounts.isValidEmail(""), false)
assert.strictEqual(accounts.isValidEmail("nobody"), false)
assert.strictEqual(accounts.isValidEmail("nobody@example"), false, "a bare host is not an address")
assert.strictEqual(accounts.isValidEmail("@example.com"), false)
assert.strictEqual(accounts.isValidEmail("two words@example.com"), false)
assert.strictEqual(accounts.isValidEmail(null), false)
assert.strictEqual(accounts.isValidEmail(undefined), false)

// The id is the address normalised once, because Google echoes the profile
// address back in whatever case the user typed it.
assert.strictEqual(accounts.accountId("  Ada@Example.COM "), "ada@example.com")
assert.strictEqual(accounts.accountId("nobody"), "")
assert.strictEqual(accounts.accountId(""), "")
assert.strictEqual(accounts.accountId(null), "")

// ------------------------------------------------------------------ labels

assert.strictEqual(accounts.label({ email: "ada@example.com", label: "Work" }), "Work")
assert.strictEqual(accounts.label({ email: "ada@example.com", label: "" }), "ada")
assert.strictEqual(accounts.label({ email: "", label: "" }), "New account")
assert.strictEqual(accounts.label({ email: "  ", label: "  " }), "New account")
assert.strictEqual(accounts.label(null), "New account")
assert.strictEqual(accounts.label({ email: "ada@example.com", label: "工作邮箱" }), "工作邮箱")

// --------------------------------------------------------------------- add

let one = accounts.add(accounts.emptyList(), account("Ada@Example.com"))
assert.strictEqual(accounts.count(one), 1)
assert.strictEqual(one.accounts[0].id, "ada@example.com")
assert.strictEqual(one.activeId, "ada@example.com", "the first account is the one on screen")
assert.strictEqual(accounts.active(one).id, "ada@example.com")
assert.strictEqual(accounts.find(one, "ada@example.com").clientId, "cid")
assert.strictEqual(accounts.find(one, "ADA@example.com"), null, "ids are looked up as stored")

const beforeAdd = frozen(one)
let two = accounts.add(one, account("bob@example.com", { label: "Personal" }))
assert.notStrictEqual(two, one)
assert.strictEqual(frozen(one), beforeAdd, "add leaves its input alone")
assert.strictEqual(accounts.count(two), 2)
assert.strictEqual(two.activeId, "ada@example.com", "a second account does not steal the selection")

// Re-adding an address is how a wrong client id gets corrected, so it must
// update the entry where it already sits rather than append a twin.
let corrected = accounts.add(two, account("ADA@example.com", { clientId: "cid2", label: "Work" }))
assert.strictEqual(accounts.count(corrected), 2)
assert.strictEqual(corrected.accounts[0].id, "ada@example.com", "the corrected account keeps its place")
assert.strictEqual(corrected.accounts[0].clientId, "cid2")
assert.strictEqual(corrected.accounts[0].label, "Work")
assert.strictEqual(corrected.accounts[1].id, "bob@example.com")
assert.strictEqual(corrected.activeId, "ada@example.com")

// ----------------------------------------------------------------- pending
//
// An account is created before the sign-in that reveals its address, so it
// has to exist with no id — and something with no id is not something the
// window can switch to.

let pending = accounts.add(accounts.emptyList(), account("", { clientId: "cid3" }))
assert.strictEqual(accounts.count(pending), 1)
assert.strictEqual(pending.accounts[0].id, "")
assert.strictEqual(pending.accounts[0].clientId, "cid3")
assert.strictEqual(pending.activeId, "", "a pending account cannot be active")
assert.strictEqual(accounts.active(pending), null)
assert.strictEqual(accounts.find(pending, ""), null, "an empty id names nothing")

// An unusable address is stored as typed and still has no id.
let typo = accounts.add(accounts.emptyList(), account("not-an-address"))
assert.strictEqual(typo.accounts[0].id, "")
assert.strictEqual(typo.accounts[0].email, "not-an-address")
assert.strictEqual(typo.activeId, "")

// Two pending accounts are two accounts: with no id there is nothing to
// de-duplicate them by.
let bothPending = accounts.add(pending, account("", { clientId: "cid4" }))
assert.strictEqual(accounts.count(bothPending), 2)
assert.strictEqual(bothPending.activeId, "")

// The first account with a real address takes the selection even though it is
// not the first in the list.
let settled = accounts.add(bothPending, account("ada@example.com"))
assert.strictEqual(settled.activeId, "ada@example.com")
assert.strictEqual(accounts.count(settled), 3)

// ------------------------------------------------------------------ remove

let three = accounts.add(corrected, account("cid@example.com"))
assert.strictEqual(accounts.count(three), 3)
const beforeRemove = frozen(three)

// Removing an account is destructive and happens in two steps. The first
// step only describes the target; it never mutates the list. A stale target
// is rejected when the confirmation is finally accepted.
const removal = accounts.removalRequest(three, 0)
deepEqual(removal, {
  id: "ada@example.com",
  email: "ADA@example.com",
  index: 0
})
assert.strictEqual(frozen(three), beforeRemove)
assert.strictEqual(accounts.removalRequest(three, -1), null)
assert.strictEqual(accounts.removalRequest(three, 99), null)
assert.strictEqual(accounts.removalRequest(one, 0), null,
  "the only account cannot be removed")
assert.strictEqual(accounts.removalRequest(bothPending, 1), null,
  "a draft has no stable identity and is canceled rather than removed")
assert.strictEqual(accounts.confirmRemoval(three, { id: "gone@example.com", index: 0 }), -1,
  "confirmation must not remove whichever account later occupies a stale row")
assert.strictEqual(accounts.confirmRemoval(three, removal), 0)

let withoutBob = accounts.remove(three, "bob@example.com")
assert.strictEqual(frozen(three), beforeRemove, "remove leaves its input alone")
assert.strictEqual(accounts.count(withoutBob), 2)
assert.strictEqual(accounts.find(withoutBob, "bob@example.com"), null)
assert.strictEqual(withoutBob.activeId, "ada@example.com", "removing another account keeps the selection")

// Removing what is on screen has to land somewhere, or the window has nothing
// to show.
let withoutAda = accounts.remove(three, "ada@example.com")
assert.strictEqual(accounts.count(withoutAda), 2)
assert.strictEqual(accounts.find(withoutAda, withoutAda.activeId) !== null, true)
assert.strictEqual(withoutAda.activeId, "bob@example.com")

// The last account leaves nothing to fall back to.
let lastGone = accounts.remove(accounts.remove(withoutAda, "bob@example.com"), "cid@example.com")
assert.strictEqual(accounts.count(lastGone), 0)
assert.strictEqual(lastGone.activeId, "")
assert.strictEqual(accounts.active(lastGone), null)

// The selection never lands on a pending account.
let realAndPending = accounts.add(accounts.add(accounts.emptyList(), account("ada@example.com")), account(""))
assert.strictEqual(accounts.remove(realAndPending, "ada@example.com").activeId, "")
assert.strictEqual(accounts.count(accounts.remove(realAndPending, "ada@example.com")), 1)

// An id nobody has, and the empty id a pending row would hand over, must not
// take anything out with them.
deepEqual(accounts.remove(three, "nobody@example.com"), three)
deepEqual(accounts.remove(realAndPending, ""), realAndPending, "an empty id must not sweep out every pending row")
assert.notStrictEqual(accounts.remove(three, "nobody@example.com"), three)

// --------------------------------------------------------------- setActive

const beforeSet = frozen(three)
let switched = accounts.setActive(three, "cid@example.com")
assert.strictEqual(frozen(three), beforeSet, "setActive leaves its input alone")
assert.strictEqual(switched.activeId, "cid@example.com")
assert.strictEqual(accounts.active(switched).id, "cid@example.com")
assert.strictEqual(accounts.count(switched), 3)

// A stale id means the caller is acting on a list that has moved on. Showing
// no mailbox at all is worse than still showing the previous one.
deepEqual(accounts.setActive(three, "nobody@example.com"), three)
deepEqual(accounts.setActive(three, ""), three)
deepEqual(accounts.setActive(realAndPending, ""), realAndPending)

// ------------------------------------------------------------------- load

deepEqual(accounts.load(""), accounts.emptyList())
deepEqual(accounts.load("{not json"), accounts.emptyList())
deepEqual(accounts.load("[]"), accounts.emptyList(), "an array is not a list of accounts")
deepEqual(accounts.load("null"), accounts.emptyList())
deepEqual(accounts.load(null), accounts.emptyList())
assert.strictEqual(accounts.isSerializedList(""), false)
assert.strictEqual(accounts.isSerializedList("{not json"), false)
assert.strictEqual(accounts.isSerializedList(JSON.stringify({
  version: accounts.VERSION, accounts: []
})), true, "a real empty first-run file is distinguishable from a failed read")
assert.strictEqual(accounts.isSerializedList(JSON.stringify({
  version: accounts.VERSION + 1, accounts: []
})), false, "a newer format must not be mistaken for this build's list")
deepEqual(accounts.load(JSON.stringify({ accounts: [] })), accounts.emptyList(), "no version at all")
deepEqual(accounts.load(JSON.stringify({
  version: accounts.VERSION + 99,
  accounts: [{ id: "ada@example.com", email: "ada@example.com" }],
  activeId: "ada@example.com"
})), accounts.emptyList(), "a newer format is discarded rather than half-read")
deepEqual(accounts.load(JSON.stringify({ version: accounts.VERSION, accounts: "nope", activeId: "x" })),
  accounts.emptyList(), "accounts that is not an array")

// A selection naming an account that is not in the file — hand-edited, or
// removed while the window was closed — must not leave the window blank.
const repaired = accounts.load(JSON.stringify({
  version: accounts.VERSION,
  accounts: [{ email: "ada@example.com" }, { email: "bob@example.com" }],
  activeId: "gone@example.com"
}))
assert.strictEqual(repaired.activeId, "ada@example.com")
assert.strictEqual(repaired.accounts[0].id, "ada@example.com", "the id is recomputed from the address")

// A file listing only pending accounts has nothing to select.
const pendingFile = accounts.load(JSON.stringify({
  version: accounts.VERSION, accounts: [{ email: "" }], activeId: "ada@example.com"
}))
assert.strictEqual(accounts.count(pendingFile), 1)
assert.strictEqual(pendingFile.activeId, "")

// Junk among the entries is skipped rather than stored as an account nobody
// can click.
const messy = accounts.load(JSON.stringify({
  version: accounts.VERSION,
  accounts: [null, "ada@example.com", { email: "bob@example.com" }, 7],
  activeId: "bob@example.com"
}))
assert.strictEqual(accounts.count(messy), 1)
assert.strictEqual(messy.activeId, "bob@example.com")

// -------------------------------------------------------------- round trip

let saved = accounts.emptyList()
saved = accounts.add(saved, account("ada@example.com", { label: "工作邮箱" }))
saved = accounts.add(saved, account("bob@example.com", { label: "Personal" }))
saved = accounts.add(saved, account("", { clientId: "cid5", pending: true }))
saved = accounts.setActive(saved, "bob@example.com")

const text = accounts.serialize(saved)
// The file crosses a line-oriented pipe on its way to disk, so a newline
// anywhere in it truncates the list.
assert.strictEqual(text.indexOf("\n"), -1, "serialize must produce a single line")
assert.strictEqual(accounts.serialize(accounts.emptyList()).indexOf("\n"), -1)

const reloaded = accounts.load(text)
deepEqual(reloaded, saved, "order, ids and the selection all survive")
assert.strictEqual(reloaded.activeId, "bob@example.com")
assert.strictEqual(accounts.label(reloaded.accounts[0]), "工作邮箱", "non-ASCII labels survive")
assert.strictEqual(accounts.count(reloaded), 3)

// A label with a newline in it is still one line on disk.
const multiline = accounts.serialize(accounts.add(accounts.emptyList(), account("ada@example.com", { label: "a\nb" })))
assert.strictEqual(multiline.indexOf("\n"), -1)
assert.strictEqual(accounts.load(multiline).accounts[0].label, "a\nb")

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
assert.strictEqual(mended.accounts[0].email, "ada@example.org",
  "the address comes back from the username it was folded into")
assert.strictEqual(mended.accounts[0].id, "imap:ada@example.org")
assert.strictEqual(mended.activeId, "imap:ada@example.org", "and the row is selectable again")
assert.strictEqual(mended.accounts[0].imap.imapHost, "imap.example.org",
  "everything else about the row is untouched")

// Only where there is an address to adopt. A username that is not one leaves
// the row exactly as unusable as it was — better than inventing something.
const unfixable = accounts.load(JSON.stringify({ version: accounts.VERSION, accounts: [{
  email: "ada", provider: "imap", imap: { imapHost: "imap.example.org", username: "ada" } }],
  activeId: "" }))
assert.strictEqual(unfixable.accounts[0].email, "ada")
assert.strictEqual(unfixable.accounts[0].id, "")

// A Gmail row has no username to adopt, and one that turned up there would not
// be an address this may act on.
const gmailRow = accounts.load(JSON.stringify({ version: accounts.VERSION, accounts: [{
  email: "ada", provider: "gmail", imap: { username: "ada@example.org" } }], activeId: "" }))
assert.strictEqual(gmailRow.accounts[0].email, "ada")

// And not while the form is open: `add` must never adopt a username, or typing
// one into the servers section would fill in an address nobody asked for.
const typing = accounts.add(accounts.emptyList(),
  { email: "", provider: "imap", imap: { username: "ada@example.org" }, pending: true })
assert.strictEqual(typing.accounts[0].email, "", "a row being typed into invents nothing")

// A real address makes a row a mailbox whatever the flag says, because
// `configureAccount` copies every key of the row it edits and a flag that had
// to be cleared by hand would have outlived setup.
const configured = accounts.add(accounts.emptyList(),
  { email: "ada@example.org", provider: "imap", pending: true })
assert.strictEqual(configured.accounts[0].pending, false)

// The whole sequence, as it happened: a corrupted mailbox on disk, then an
// unrelated account added. It was that second step that satisfied the old
// list-wide guard and let the write through with the first row missing.
let recovered = accounts.load(damaged)
recovered = accounts.add(recovered, account("bob@example.com"))
const payload = accounts.savedOnly(recovered)
assert.strictEqual(accounts.count(payload), 2, "adding one mailbox must not delete another")
deepEqual(payload.accounts.map(a => a.email), ["ada@example.org", "bob@example.com"])
assert.strictEqual(accounts.dropsNamedMailbox(recovered, payload), false)

// -------------------------------------------------------------- what is written
//
// The row `add` creates before anything has been typed into it is the setup
// form's working state, not a mailbox, and it says so — `pending`. Any save
// used to carry whichever draft happened to be open along with it, leaving a
// "New mailbox" on disk that nothing could select and nothing could remove.
const withDraft = accounts.savedOnly(saved)
assert.strictEqual(accounts.count(saved), 3, "savedOnly leaves its input alone")
assert.strictEqual(accounts.count(withDraft), 2, "the draft row is not written")
deepEqual(withDraft.accounts.map(a => a.id), ["ada@example.com", "bob@example.com"])
assert.strictEqual(withDraft.activeId, "bob@example.com", "the selection is kept")
assert.strictEqual(accounts.draftCount(saved), 1)

// A draft is a row that says it is one. Inferring it from a missing id read a
// mailbox whose address had been corrupted as working state and dropped it
// here — which is how adding one mailbox deleted a different, working one.
// This row has no id either, and it is not a draft: its servers were typed in
// and its password is in the keyring.
let broken = accounts.emptyList()
broken = accounts.add(broken, account("ada@example.com"))
broken = accounts.add(broken, account("ada", { provider: "imap",
  imap: { imapHost: "imap.example.org", username: "ada" } }))
assert.strictEqual(accounts.count(accounts.savedOnly(broken)), 2,
  "a mailbox with an unusable address is kept, not quietly deleted")
assert.strictEqual(accounts.draftCount(broken), 0)

// A row holding nothing at all is a different thing: the leftover of an Add
// nobody filled in, and there is nothing in one to preserve.
let hollow = accounts.emptyList()
hollow = accounts.add(hollow, account("ada@example.com"))
hollow = accounts.add(hollow, { email: "" })
assert.strictEqual(accounts.count(accounts.savedOnly(hollow)), 1)
assert.strictEqual(accounts.carriesData({ email: "", imap: {} }), false)
assert.ok(accounts.carriesData({ id: "", imap: { username: "ada@example.org" } }))

// Nothing may drop a mailbox the list can name. The guard this replaces asked
// only whether the payload still held *some* mailbox, which one freshly added
// account was enough to satisfy.
assert.ok(accounts.dropsNamedMailbox(broken, accounts.emptyList()))
assert.strictEqual(accounts.dropsNamedMailbox(saved, accounts.savedOnly(saved)), false)
assert.strictEqual(accounts.dropsNamedMailbox(broken, accounts.savedOnly(broken)), false)

// The selection follows when the row it named is the one dropped.
let activeDraft = accounts.add(accounts.emptyList(), account("ada@example.com"))
activeDraft = accounts.add(activeDraft, account(""))
activeDraft.activeId = ""
assert.strictEqual(accounts.savedOnly(activeDraft).activeId, "ada@example.com",
  "a list written with no selection still names a mailbox")

// Nothing to keep is left empty rather than invented; the write guard in
// Service.saveAccounts is what stops that reaching disk.
assert.strictEqual(accounts.count(accounts.savedOnly(
  accounts.add(accounts.emptyList(), { email: "", pending: true }))), 0)
assert.strictEqual(accounts.serialize(accounts.savedOnly(saved)).indexOf("\n"), -1)

// An idless row is not necessarily the setup form's draft. A legacy mailbox
// whose address cannot be repaired is deliberately kept by `savedOnly`, and
// cancelling a draft must not become a second path that silently deletes it.
const damagedDraftLookalike = accounts.add(accounts.emptyList(), {
  email: "ada", provider: "imap",
  imap: { imapHost: "imap.example.org", username: "ada" }
})
assert.strictEqual(accounts.count(accounts.discardDraftAt(damagedDraftLookalike, 0)), 1,
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
assert.strictEqual(accounts.count(pendingList), 3)

const withoutPending = accounts.removeAt(pendingList, 1)
assert.strictEqual(accounts.count(withoutPending), 2)
assert.strictEqual(withoutPending.accounts[1].email, "two@example.com")
assert.strictEqual(accounts.count(pendingList), 3, "the input is left alone")

// Removing the active account by index hands the selection on, exactly as
// removing it by id does.
const activeGone = accounts.removeAt(withoutPending, 0)
assert.strictEqual(accounts.count(activeGone), 1)
assert.strictEqual(activeGone.activeId, "two@example.com")

// Out of range is inert rather than destructive.
assert.strictEqual(accounts.count(accounts.removeAt(pendingList, 99)), 3)
assert.strictEqual(accounts.count(accounts.removeAt(pendingList, -1)), 3)
assert.strictEqual(accounts.count(accounts.removeAt(pendingList, "nonsense")), 3)

// Cancelling Add removes only the unnamed draft. Once an address has been
// saved, Back is navigation and must not delete the account.
assert.strictEqual(accounts.count(accounts.discardDraftAt(pendingList, 1)), 2)
assert.strictEqual(accounts.count(accounts.discardDraftAt(pendingList, 0)), 3)

// ---------------------------------------------------------------- providers
//
// A mailbox is Gmail, IMAP, or HEY. The rules that matter are what an upgrade
// does to accounts written before providers existed, and what happens when one
// address is reached two different ways.

{
  // Anything unrecognised — an empty field, a newer build's name, a hand edit —
  // is Gmail, because that is what every account in an upgraded install is.
  assert.strictEqual(accounts.makeAccount({ email: "jane@gmail.com" }).provider, "gmail")
  assert.strictEqual(accounts.makeAccount({ email: "j@x.com", provider: "" }).provider, "gmail")
  assert.strictEqual(accounts.makeAccount({ email: "j@x.com", provider: "pigeon" }).provider, "gmail")
  assert.strictEqual(accounts.makeAccount({ email: "j@x.com", provider: "IMAP" }).provider, "imap")
  assert.strictEqual(accounts.makeAccount({ email: "j@x.com", provider: " hey " }).provider, "hey")

  // A Gmail account keeps the bare address as its id, so nothing already on
  // disk — its cache directory, its keyring entry, the activeId in the file —
  // needs migrating when this build first runs.
  assert.strictEqual(accounts.makeAccount({ email: "Jane@Gmail.com" }).id, "jane@gmail.com")
  assert.strictEqual(
    accounts.makeAccount({ email: "jane@fastmail.com", provider: "imap" }).id,
    "imap:jane@fastmail.com")

  // The same address reached two ways is two mailboxes, not one overwriting
  // the other.
  let list = accounts.emptyList()
  list = accounts.add(list, { email: "jane@gmail.com", provider: "gmail" })
  list = accounts.add(list, { email: "jane@gmail.com", provider: "imap" })
  assert.strictEqual(accounts.count(list), 2,
    "one address over two providers is two accounts")
  assert.strictEqual(accounts.find(list, "jane@gmail.com").provider, "gmail")
  assert.strictEqual(accounts.find(list, "imap:jane@gmail.com").provider, "imap")

  // Re-adding the same one still replaces in place rather than appending.
  list = accounts.add(list, { email: "jane@gmail.com", provider: "imap", label: "Work" })
  assert.strictEqual(accounts.count(list), 2)
  assert.strictEqual(accounts.find(list, "imap:jane@gmail.com").label, "Work")

  // Removing one leaves the other.
  list = accounts.remove(list, "imap:jane@gmail.com")
  assert.strictEqual(accounts.count(list), 1)
  assert.strictEqual(accounts.find(list, "jane@gmail.com").provider, "gmail")
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
  assert.strictEqual(reloaded.provider, "imap")
  assert.strictEqual(reloaded.imap.imapHost, "imap.fastmail.com")
  assert.strictEqual(reloaded.imap.smtpPort, 465)
  assert.strictEqual(reloaded.imap.username, "jane@fastmail.com")
  assert.strictEqual(reloaded.imap.aliases.length, 2)
  assert.strictEqual(reloaded.imap.aliases[0].email, "alias@fastmail.com")
  assert.strictEqual(reloaded.imap.aliases[0].isDefault, true)
  assert.strictEqual(reloaded.imap.aliases[1].isDefault, false)
  assert.strictEqual(reloaded.imap.insecure, false)

  // Ports out of range fall back rather than reaching a URL.
  const clamped = accounts.makeAccount({
    email: "j@x.com", provider: "imap",
    imap: { imapPort: 0, smtpPort: 999999 }
  })
  assert.strictEqual(clamped.imap.imapPort, 993)
  assert.strictEqual(clamped.imap.smtpPort, 465)

  // A Gmail account still serialises without IMAP settings meaning anything.
  const gmail = accounts.makeAccount({ email: "j@gmail.com", clientId: "abc" })
  assert.strictEqual(gmail.imap.imapHost, "")
  assert.strictEqual(gmail.clientId, "abc")

  // An accounts.json written by the previous build has no provider field at
  // all, and every account in it must come back as a working Gmail account.
  const legacy = accounts.load(JSON.stringify({
    version: 1,
    accounts: [{ id: "jane@gmail.com", email: "jane@gmail.com", clientId: "abc" }],
    activeId: "jane@gmail.com"
  }))
  assert.strictEqual(accounts.count(legacy), 1)
  assert.strictEqual(legacy.activeId, "jane@gmail.com",
    "the active account is still the one the user was looking at")
  assert.strictEqual(accounts.active(legacy).provider, "gmail")
  assert.strictEqual(accounts.active(legacy).clientId, "abc")
}

// ------------------------------------------------------------- signatures

{
  // Absent is empty, so an account written before the field existed loads with
  // a signature rather than an undefined one every caller has to guard.
  assert.strictEqual(accounts.makeAccount({ email: "j@gmail.com" }).signature, "")
  assert.strictEqual(accounts.makeAccount({
    email: "j@gmail.com", signature: "  Maarten\nmadra.nl  "
  }).signature, "Maarten\nmadra.nl", "the ends are trimmed, the middle is not")

  const list = accounts.add(accounts.emptyList(), account("jane@gmail.com"))
  const before = frozen(list)

  const signed = accounts.setSignature(list, "jane@gmail.com", "Jane\nRoe")
  assert.strictEqual(accounts.find(signed, "jane@gmail.com").signature, "Jane\nRoe")
  assert.strictEqual(frozen(list), before, "the list handed in is not edited")

  // Setting one must not disturb the rest of the entry, which is the whole
  // account: a signature edit that dropped an OAuth client would sign the user
  // out to save a sign-off.
  const entry = accounts.find(signed, "jane@gmail.com")
  assert.strictEqual(entry.clientId, "cid")
  assert.strictEqual(entry.clientSecret, "secret")
  assert.strictEqual(entry.provider, "gmail")
  assert.strictEqual(signed.activeId, "jane@gmail.com")

  // Clearing is setting it to nothing, not a second operation.
  assert.strictEqual(accounts.find(accounts.setSignature(signed, "jane@gmail.com", ""),
    "jane@gmail.com").signature, "")

  // An id the list does not hold is a caller acting on a list that has moved
  // on — the same rule the other mutators follow, so it changes nothing.
  assert.strictEqual(frozen(accounts.setSignature(list, "nobody@gmail.com", "x")), before)
  assert.strictEqual(frozen(accounts.setSignature(list, "", "x")), before)

  // A signature is the one field here that legitimately contains newlines, and
  // the file crosses a line-oriented pipe on the way to disk. JSON escaping is
  // what keeps a two-line sign-off from truncating the account list.
  const stored = accounts.serialize(signed)
  assert.ok(stored.indexOf("\n") < 0, "no raw newline reaches the writer")
  const reloaded = accounts.load(stored)
  assert.strictEqual(accounts.find(reloaded, "jane@gmail.com").signature, "Jane\nRoe",
    "what was typed comes back")

  // Two mailboxes are two identities. Signing one must leave the other unsigned.
  const both = accounts.add(signed, account("john@gmail.com"))
  assert.strictEqual(accounts.find(both, "john@gmail.com").signature, "")
  assert.strictEqual(accounts.find(both, "jane@gmail.com").signature, "Jane\nRoe")
}

console.log("test_accounts.js ok")

// ------------------------------------------------------------- the name

// Two mailboxes can differ only in their domain and elide to the same handful
// of characters in a list, so a name is the one thing that tells them apart.
const named = accounts.setLabel(
  accounts.add(accounts.emptyList(), { email: "me@gmail.com", provider: "gmail" }),
  "me@gmail.com", "  Private  ")
assert.strictEqual(named.accounts[0].label, "Private", "trimmed on the way in")
assert.strictEqual(accounts.label(named.accounts[0]), "Private")

// Empty is not a name and clears it, which puts the address back: `label`
// falls through to the local part, so a mailbox is never left unnamed.
const cleared = accounts.setLabel(named, "me@gmail.com", "   ")
assert.strictEqual(cleared.accounts[0].label, "")
assert.strictEqual(accounts.label(cleared.accounts[0]), "me")

// Naming a mailbox that is not in the list changes nothing rather than adding
// one, the way every other edit here behaves.
assert.strictEqual(
  accounts.serialize(accounts.setLabel(named, "nobody@example.org", "Ghost")),
  accounts.serialize(named))

// The rest of the entry survives, because the row is rebuilt rather than
// patched and a field added later must not drop one added earlier.
const withBoth = accounts.setSignature(named, "me@gmail.com", "Best, me")
assert.strictEqual(withBoth.accounts[0].label, "Private")
assert.strictEqual(withBoth.accounts[0].signature, "Best, me")
assert.strictEqual(
  accounts.setLabel(withBoth, "me@gmail.com", "Personal").accounts[0].signature,
  "Best, me", "naming a mailbox does not forget its signature")
