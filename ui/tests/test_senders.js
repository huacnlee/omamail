const assert = require("assert")
const { load, deepEqual } = require("./load")

const senders = load("compose/Senders.js")

const gmail = {
  id: "work@example.com",
  email: "work@example.com",
  label: "work",
  ready: true,
  canSend: true,
  aliases: [
    { email: "work@example.com", displayName: "Work" },
    { email: "alias@example.com", displayName: "Alias" }
  ]
}
const imap = {
  id: "imap:home@example.com",
  email: "home@example.com",
  label: "home",
  ready: true,
  canSend: true,
  aliases: [{ email: "home@example.com", displayName: "" }]
}

deepEqual(senders.identities([gmail, imap]), [
  { accountId: "work@example.com", email: "work@example.com",
    displayName: "Work", label: "work" },
  { accountId: "work@example.com", email: "alias@example.com",
    displayName: "Alias", label: "work" },
  { accountId: "imap:home@example.com", email: "home@example.com",
    displayName: "", label: "home" }
])

deepEqual(senders.identities([gmail, {
  id: "hey:me@hey.com", email: "me@hey.com", label: "hey",
  ready: true, canSend: false, aliases: []
}]).map(function (row) { return row.accountId }),
  ["work@example.com", "work@example.com"],
  "a mailbox that cannot send is not a From choice")

deepEqual(senders.identities([{
  id: "imap:home@example.com", email: "home@example.com", label: "home",
  ready: false, canSend: true, aliases: []
}]), [], "a mailbox that is not signed in is not a From choice")

const all = senders.identities([gmail, imap])
deepEqual(senders.visible(all, "work@example.com", "new"), all,
  "a new message may be sent from any connected mailbox")
deepEqual(senders.visible({ 0: all[0], 1: all[1], 2: all[2], length: 3 },
  "work@example.com", "new"), all,
  "a QML list of identities is still a list")
deepEqual(senders.visible(all, "work@example.com", "reply").map(function (row) {
  return row.email
}), ["work@example.com", "alias@example.com"],
  "a reply stays on the mailbox that received the message")
deepEqual(senders.visible(all, "work@example.com", "forward").length, 2)

assert.strictEqual(senders.subtitle({ displayName: "Work", label: "work",
  email: "work@example.com" }), "Work")
assert.strictEqual(senders.subtitle({ displayName: "", label: "home",
  email: "home@example.com" }), "home")
assert.strictEqual(senders.subtitle({ displayName: "", label: "home@example.com",
  email: "home@example.com" }), "", "the address is already the title")

console.log("test_senders.js ok")
