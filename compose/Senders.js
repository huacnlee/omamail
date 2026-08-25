.pragma library

// Who a new message may be sent as. One mailbox can have several of its own
// addresses; several mailboxes can be signed in at once. The compose form
// needs one list of both, because a From that only names the current
// mailbox's aliases leaves every other connected account unreachable.
//
// A reply or forward stays on the mailbox that holds the original: sending
// that draft from a different account would hand another server a thread id
// it has never seen.

// QML `var` arrays are sometimes length-bearing objects, not JS Array.
// Array.isArray is then false and From would list nobody.
function asList(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value
  var n = value.length
  if (typeof n !== "number" || n < 1) return []
  var out = []
  var i
  for (i = 0; i < n; i++) {
    if (value[i] !== undefined) out.push(value[i])
  }
  return out
}

function identities(mailboxes) {
  var rows = asList(mailboxes)
  var out = []
  var seen = ({})
  var i
  for (i = 0; i < rows.length; i++) {
    var box = rows[i] || ({})
    if (box.ready !== true || box.canSend === false) continue
    var accountId = String(box.id || "")
    if (accountId === "") continue
    var aliases = Array.isArray(box.aliases) ? box.aliases : []
    if (aliases.length === 0) {
      var fallback = String(box.email || "").trim()
      if (fallback === "") continue
      aliases = [{ email: fallback, displayName: String(box.displayName || "") }]
    }
    var j
    for (j = 0; j < aliases.length; j++) {
      var alias = aliases[j] || ({})
      var email = String(alias.email || "").trim()
      if (email === "") continue
      var key = accountId + "\n" + email.toLowerCase()
      if (seen[key]) continue
      seen[key] = true
      out.push({
        accountId: accountId,
        email: email,
        displayName: String(alias.displayName || ""),
        label: String(box.label || "")
      })
    }
  }
  return out
}

function visible(rows, accountId, mode) {
  var list = asList(rows)
  var kind = String(mode || "new")
  if (kind === "new" || kind === "") return list
  var wanted = String(accountId || "")
  var kept = []
  var i
  for (i = 0; i < list.length; i++) {
    if (String(list[i].accountId || "") === wanted) kept.push(list[i])
  }
  return kept
}

function subtitle(identity) {
  var row = identity || ({})
  var name = String(row.displayName || "").trim()
  if (name !== "") return name
  var label = String(row.label || "").trim()
  var email = String(row.email || "").trim()
  if (label !== "" && label.toLowerCase() !== email.toLowerCase()) return label
  return ""
}
