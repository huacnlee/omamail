.pragma library

.import "HeyCli.js" as Cli

// What HEY is, as far as the panel is concerned.
//
// Not how to talk to it — that is `HeyCli.js` for the commands and
// `HeyClient.qml` for the process. This file answers the questions
// `Registry.js` asks of every provider: what mailboxes are there, what does a
// query mean, what can it be asked to do, and how does it sign in.
//
// HEY has no IMAP, no POP and no public HTTP API, so for a long time this file
// was a placeholder saying so. 37signals now publish `hey`, a supported command
// line client, and that is the interface this provider speaks — the same
// answer as "wait for a supported interface", now that there is one. Nothing
// here reaches app.hey.com's own endpoints.

var ID = "hey"
var NAME = "HEY"

// One line, on the provider chooser. It has to say what the user is committing
// to, and for HEY that is a program they may not have yet.
var SUMMARY = "37signals' own mailbox, read through the HEY CLI they publish."

// Neither a browser this plugin drives nor a password it holds: `hey` owns the
// whole sign-in, including the token and where it is kept.
var AUTH = "cli"

// The service's own artwork, in `assets/`. HEY has two, and they are not
// interchangeable: the square icon for a row in the chooser, and the wordmark
// for the page about HEY, which is how 37signals present the brand at that
// size. IMAP has neither on purpose — it is a protocol rather than a brand, and
// no mark would be honest about the server somebody is actually connecting to.
// Where the client this provider runs on lives. A different address from the
// service's own: `webHomeUrl` is HEY, this is the program that reaches it, and
// the setup page links each from the words that name them.
var CLIENT_URL = "https://github.com/basecamp/hey-cli"

var MARK = "hey-mark.png"
var LOGO = "hey.png"

var CAPABILITIES = {
  // HEY files a thread under any number of labels, and `hey labels` lists them.
  labels: true,
  // A topic id, which is HEY's own conversation.
  threads: true,
  // Deliberately off. HEY has no archive: a thread is moved to another box, or
  // set aside, or left where it is, and none of those is what the key means.
  // Spending "e" on a move to Paper Trail would file mail somewhere the user
  // did not choose, which is worse than the key doing nothing.
  archive: false,
  // `hey spam` moves the thread and trains the filter, which is the whole of
  // what the button promises.
  spam: true,
  // HEY has no flag. Set Aside and Reply Later are boxes, not a star, and a
  // star that quietly moved a thread out of the Imbox is a promise this
  // provider cannot keep.
  star: false,
  // Every verb takes a list of ids in one invocation.
  batch: true,
  // A thread has an address of its own in HEY's web app, so a message opens
  // there exactly.
  web: true,
  // A mailbox does not. HEY has a URL per box and none for a search or a
  // label, so "Open web inbox" could only ever open the Imbox — which is not
  // where the user is standing whenever it would be worth pressing.
  webBox: false,
  search: true,
  send: true
}

// HEY's own boxes, in the order HEY puts them in. The query strings are read by
// `HeyCli.parseQuery` and by nothing else — everywhere above, they are opaque,
// handed back to the client that produced them and used as a cache key.
//
// The keys are Omamail's rather than HEY's where the two disagree: "inbox" is
// the Imbox because `Model.survivesAction` names that key when it decides
// whether an action evicts a row, and a second name for the first mailbox would
// have to be taught to every one of those rules.
var MAILBOXES = [
  { key: "inbox", label: "Imbox", icon: "inbox", query: "box:imbox" },
  // What HEY calls New for You: the Imbox, less everything already seen. There
  // is no unseen box to ask for, so the client lists and filters — which is
  // also what the unread badge counts.
  { key: "unread", label: "New for you", icon: "unread", query: "box:imbox unseen" },
  { key: "drafts", label: "Drafts", icon: "compose", query: "drafts:" },
  { key: "later", label: "Reply Later", icon: "reply", query: "box:laterbox" },
  { key: "aside", label: "Set Aside", icon: "pin", query: "box:asidebox" },
  { key: "feed", label: "The Feed", icon: "label", query: "box:feedbox" },
  // Optional: the first to go when the row cannot hold every mailbox. Neither
  // is somewhere anyone works from.
  { key: "papertrail", label: "Paper Trail", icon: "archive", query: "box:trailbox", optional: true },
  // HEY serves no trash box, only a search scoped to it. The DSL says
  // `box:trash` all the same, because which command answers a mailbox is the
  // client's business rather than the sidebar's.
  { key: "trash", label: "Trash", icon: "trash", query: "box:trash", optional: true }
]

// Free text goes to HEY's own search, which is what the web app runs. The
// prefix is what keeps a typed `box:imbox` a search for those words rather than
// a mailbox switch nobody asked for.
function searchQuery(text) {
  var value = String(text === undefined || text === null ? "" : text).trim()
  return value === "" ? "" : "search:" + value
}

// An unrefined `hey search` searches across the mailbox. Its `--in` refinement
// can name only Imbox, Feed, Paper Trail or Trash, but a typed search here does
// not apply that refinement — so every cached box and label is eligible for
// the conservative text match.
function cachedSummaryInSearch(sourceQuery, summary) {
  return true
}

// Selecting a label in the sidebar. HEY addresses a label by id, not by name —
// `hey label <id>` takes nothing else — so the id is what the sidebar carries
// as a label's `rawName` and what arrives here.
function labelQuery(name) {
  var value = String(name === undefined || name === null ? "" : name).trim()
  return value === "" ? "" : "label:" + value
}

// Where a thread lives in HEY's own web app. Both halves of a message id are
// numbers HEY's URLs are made of, so this needs nothing the row did not already
// have.
//
// There is deliberately no `webBoxUrl` beside it: `webBox` is off, and a
// function that answered anyway would be a second place for the same "close
// enough" to come back through.
function webMessageUrl(messageId) {
  return Cli.webMessageUrl(messageId)
}

// The service's own front door. HEY has one of these even though it has no
// address for an arbitrary mailbox, which is why it is a separate question from
// `webBox`.
function webHomeUrl() {
  return Cli.webHomeUrl()
}
