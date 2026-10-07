const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { load } = require("./load")
const actions = load("account/MessageActions.js")
const compatibility = load("backend/Compatibility.js")
const provider = load("providers/Registry.js")
const keymap = load("keys/Keymap.js")
const contract = JSON.parse(fs.readFileSync(path.join(__dirname, "../../backend-api.json")))

function backend(apiVersion, methods, ready = true) {
  return { ready, protocolInfo: { apiVersion, protocol: 1, version: "0.10.8", methods } }
}
assert.strictEqual(compatibility.accepts(backend(6, []).protocolInfo, "0.10.8", 6, 7), true,
  "the released binary remains compatible with this checkout")
assert.strictEqual(compatibility.accepts(backend(7, []).protocolInfo, "0.10.8", 6, 7), true)
assert.strictEqual(contract.apiVersion, 7)
assert.strictEqual(contract.releasedApiVersion, 6)
assert.deepStrictEqual(contract.unreleased.methods, ["mail.exportEml"])
assert.strictEqual(actions.backendCanExportEml(backend(6, ["mail.exportEml"])), false,
  "API 7 is the fixed minimum even if an older backend advertises the method")
assert.strictEqual(actions.backendCanExportEml(backend(6, ["mail.read"])), false)
assert.strictEqual(actions.backendCanExportEml(backend(7, ["mail.read"])), false)
assert.strictEqual(actions.backendCanExportEml(backend(7, ["mail.exportEml"], false)), false)
assert.strictEqual(actions.backendCanExportEml(null), false)
for (const api of [7, 8])
  assert.strictEqual(actions.backendCanExportEml(backend(api, ["mail.exportEml"])), true,
    "the export gate survives release and subsequent revisions")
assert.deepStrictEqual(JSON.parse(JSON.stringify(compatibility.unreleasedRefusal(
  "mail.exportEml", contract.unreleased.methods, true))),
  { code: -32012, message: "backend_needs_update" })
assert.strictEqual(compatibility.unreleasedRefusal("mail.read", contract.unreleased.methods, true), null)
assert.strictEqual(keymap.conflicts().length, 0)
assert.strictEqual(keymap.byId("exportEml").keys[0], "Ctrl+Shift+S")
assert.strictEqual(keymap.isEnabled(keymap.byId("exportEml"), "compose", false), false)
assert.strictEqual(keymap.isEnabled(keymap.byId("exportEml"), "search", false), false)

const dispatched = []
function account(id, providerId) {
  return { accountId: id, ready: true, canExportEml: provider.can(providerId, "emlExport"),
    exportEml: nativeId => { dispatched.push({ account: id, id: nativeId }); return true },
    fail: () => {} }
}
const ada = account("imap:ada@example.org", "imap")
const bob = account("outlook:bob@example.org", "outlook")
const service = { current: ada, unified: false, selectedId: "17:INBOX",
  backendCanExportEml: false, fail: () => {},
  findAccount: id => [ada, bob].find(a => a.accountId === id) || null,
  hostForId: id => service.unified ? service.findAccount(String(id).split("/")[0]) : service.current,
  sourceIdFor: id => service.unified ? String(id).split("/")[1] : id }
service.canExportEmlFor = id => actions.canExportEmlFor(service, id)
for (const api of [6, 7]) {
  service.backendCanExportEml = actions.backendCanExportEml(backend(api, api === 7 ? ["mail.exportEml"] : ["mail.read"]))
  assert.strictEqual(actions.hiddenBindings(service, "list", "42:INBOX").includes("exportEml"), api === 6)
  assert.strictEqual(actions.canExportEmlFor(service, "42:INBOX"), api === 7)
  assert.strictEqual(actions.exportFromView(service, "list", "42:INBOX"), api === 7)
  assert.strictEqual(dispatched.length, api === 7 ? 1 : 0,
    "API 6 must refuse before provider work is dispatched")
}
assert.deepStrictEqual(dispatched.pop(), { account: ada.accountId, id: "42:INBOX" })
assert.strictEqual(actions.exportFromView(service, "reader", "42:INBOX"), true)
assert.deepStrictEqual(dispatched.pop(), { account: ada.accountId, id: "17:INBOX" })
assert.strictEqual(actions.exportFromView(service, "list", ""), false)
const captured = actions.accountForMessage(service, "42:INBOX")
service.current = bob
assert.strictEqual(actions.exportEmlFor(service, captured, "42:INBOX"), false)
assert.strictEqual(actions.exportEmlFor(service, "", "42:INBOX"), false)
assert.strictEqual(dispatched.length, 0, "a stale menu cannot export another account's message")
service.unified = true
assert.strictEqual(actions.exportEml(service, ada.accountId + "/17:INBOX"), true)
assert.deepStrictEqual(dispatched.pop(), { account: ada.accountId, id: "17:INBOX" })
assert.strictEqual(actions.exportEml(service, "imap:removed@example.org/17:INBOX"), false)
assert.strictEqual(dispatched.length, 0, "a missing unified owner cannot fall back to the active account")
for (const id of ["gmail", "hey", "jmap"]) {
  service.unified = false
  service.current = account(id + ":other@example.org", id)
  assert.strictEqual(actions.exportFromView(service, "list", "42:INBOX"), false)
  assert.strictEqual(actions.hiddenBindings(service, "list", "42:INBOX").includes("exportEml"), true)
}
assert.strictEqual(dispatched.length, 0)
assert.strictEqual(actions.exportSavedNotice({ filename: "Project update (2).eml",
  path: "/home/ada/Downloads/Project update (2).eml" }), "Saved Project update (2).eml to /home/ada/Downloads",
  "the notice names the file once, then its folder")
assert.strictEqual(actions.exportSavedNotice({ filename: "",
  path: "C:\\Users\\ada\\Downloads\\note.eml" }), "Saved note.eml to C:\\Users\\ada\\Downloads")
assert.strictEqual(actions.exportSavedNotice({}), "Saved the message as .eml")
assert.strictEqual(actions.exportErrorText({ code: -32000, message: "mail_export_too_large" }),
  "This message is larger than 25 MB, so it was not saved")
assert.strictEqual(actions.exportErrorText({ message: "request_timed_out" }),
  "The mail server did not answer in time, so nothing was saved")
for (const code of ["mail_export_write_failed", "mail_export_message_missing", "backend_needs_update"])
  assert.ok(!/_/.test(actions.exportErrorText({ message: code })), "no raw code reaches the status line")
assert.strictEqual(actions.exportErrorText({ message: "mail_tls_failed" }), "Could not save the message as .eml")
assert.strictEqual(actions.exportErrorText({ message: "constructor" }), "Could not save the message as .eml")
assert.strictEqual(actions.exportErrorText(null), "Could not save the message as .eml")
// A picked folder rides the same dispatch boundary, captured owner and all.
const folderCalls = []
const desk = account("imap:desk@example.org", "imap")
desk.exportEml = (nativeId, directory) => { folderCalls.push({ id: nativeId, directory }); return true }
let chooserAnswer = null
const plugin = { current: desk, unified: false, standalone: false, selectedId: "",
  backendCanExportEml: true, failures: [], fail: text => plugin.failures.push(text),
  findAccount: id => id === desk.accountId ? desk : null,
  hostForId: () => plugin.current, sourceIdFor: id => id,
  chooseFiles: (done, folder) => { assert.strictEqual(folder, true); done(chooserAnswer); return true } }
plugin.canExportEmlFor = id => actions.canExportEmlFor(plugin, id)
chooserAnswer = { ok: true, paths: ["/home/ada/Mail archive"] }
assert.strictEqual(actions.exportEmlToFolder(plugin, desk.accountId, "9:INBOX"), true)
assert.deepStrictEqual(folderCalls.pop(), { id: "9:INBOX", directory: "/home/ada/Mail archive" })
chooserAnswer = { ok: false, error: "cancelled" }
actions.exportEmlToFolder(plugin, desk.accountId, "9:INBOX")
assert.strictEqual(folderCalls.length, 0, "a cancelled chooser saves nothing")
assert.deepStrictEqual(plugin.failures, [], "and says nothing")
chooserAnswer = { ok: false, error: "No folder picker is available" }
actions.exportEmlToFolder(plugin, desk.accountId, "9:INBOX")
assert.deepStrictEqual(plugin.failures, ["No folder picker is available"])
// An account switch while the chooser was open refuses, as a stale menu does.
chooserAnswer = { ok: true, paths: ["/home/ada/Mail archive"] }
plugin.chooseFiles = done => { plugin.current = bob; done(chooserAnswer); return true }
plugin.findAccount = id => [desk, bob].find(a => a.accountId === id) || null
actions.exportEmlToFolder(plugin, desk.accountId, "9:INBOX")
assert.strictEqual(folderCalls.length, 0, "the folder answer cannot reach another mailbox")
plugin.current = desk
plugin.standalone = true
assert.strictEqual(actions.exportEmlToFolder(plugin, desk.accountId, "9:INBOX"), false,
  "the standalone app has no out-of-process chooser")
plugin.standalone = false
plugin.backendCanExportEml = false
assert.strictEqual(actions.exportEmlToFolder(plugin, desk.accountId, "9:INBOX"), false,
  "no chooser opens for a backend that cannot export")

assert.deepStrictEqual(JSON.parse(JSON.stringify(actions.exportSavedFile({ filename: "Project update (2).eml",
  path: "/home/ada/Downloads/Project update (2).eml" }, "/home/ada"))),
  { name: "Project update (2).eml", folder: "/home/ada/Downloads", shownFolder: "~/Downloads" })
assert.strictEqual(actions.exportSavedFile({ path: "/home/adam/x.eml" }, "/home/ada").shownFolder,
  "/home/adam", "a sibling of home is not shortened")
assert.strictEqual(actions.exportSavedFile({ path: "/srv/mail/x.eml" }, "").shownFolder, "/srv/mail")
assert.strictEqual(actions.exportErrorText({ message: "mail_export_write_failed" }, "/home/ada/Mail"),
  "Could not write the .eml file to /home/ada/Mail", "a picked folder is named in the failure")
assert.strictEqual(actions.exportErrorText({ message: "mail_export_write_failed" }),
  "Could not write the .eml file to Downloads")
console.log("eml export API gate and account routing tests passed")
