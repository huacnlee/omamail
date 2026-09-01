.pragma library

function cleanContact(value) {
  var contact = value || ({})
  var name = String(contact.name || "").replace(/[\r\n]+/g, " ").trim()
  var email = String(contact.email || "").replace(/[\r\n\s]+/g, "").trim()
  if (email.indexOf("@") <= 0 || email.indexOf("@") === email.length - 1) return null
  return ({ name: name, email: email })
}

function normalize(values) {
  var contacts = Array.isArray(values) ? values : []
  var seen = ({})
  var out = []
  for (var i = 0; i < contacts.length; i++) {
    var contact = cleanContact(contacts[i])
    if (!contact) continue
    var key = contact.email.toLowerCase()
    if (seen[key]) continue
    seen[key] = true
    out.push(contact)
  }
  return out
}

function currentToken(text) {
  var value = String(text || "")
  var comma = value.lastIndexOf(",")
  var semicolon = value.lastIndexOf(";")
  return value.substring(Math.max(comma, semicolon) + 1).trim()
}

function usedAddresses(text) {
  var parts = String(text || "").split(/[,;]/)
  var used = ({})
  for (var i = 0; i < parts.length - 1; i++) {
    var angle = parts[i].match(/<([^>]+)>/)
    var email = angle ? angle[1] : parts[i]
    used[String(email || "").trim().toLowerCase()] = true
  }
  return used
}

function suggest(values, text, limit) {
  var query = currentToken(text).toLowerCase()
  if (query === "") return []
  var contacts = normalize(values)
  var used = usedAddresses(text)
  var ranked = []
  for (var i = 0; i < contacts.length; i++) {
    var contact = contacts[i]
    var email = contact.email.toLowerCase()
    var name = contact.name.toLowerCase()
    if (used[email] || query === email) continue
    var emailAt = email.indexOf(query)
    var nameAt = name.indexOf(query)
    if (emailAt < 0 && nameAt < 0) continue
    ranked.push({
      contact: contact,
      score: emailAt === 0 || nameAt === 0 ? 0 : 1
    })
  }
  ranked.sort(function(left, right) {
    if (left.score !== right.score) return left.score - right.score
    var leftName = (left.contact.name || left.contact.email).toLowerCase()
    var rightName = (right.contact.name || right.contact.email).toLowerCase()
    return leftName < rightName ? -1 : (leftName > rightName ? 1 : 0)
  })
  var count = Math.max(1, Math.floor(Number(limit) || 5))
  var out = []
  for (var j = 0; j < ranked.length && j < count; j++) out.push(ranked[j].contact)
  return out
}

function address(contact) {
  var value = cleanContact(contact)
  if (!value) return ""
  if (value.name === "") return value.email
  var name = value.name.replace(/([\\"])/g, "\\$1")
  if (/[,<>]/.test(name)) name = "\"" + name + "\""
  return name + " <" + value.email + ">"
}

function accept(text, contact) {
  var value = String(text || "")
  var comma = value.lastIndexOf(",")
  var semicolon = value.lastIndexOf(";")
  var split = Math.max(comma, semicolon)
  var prefix = split >= 0 ? value.substring(0, split + 1).trim() + " " : ""
  return prefix + address(contact)
}

function append(text, contact) {
  var addr = address(contact)
  if (!addr) return String(text || "")
  var current = String(text || "").trim()
  if (current === "") return addr
  current = current.replace(/[,;]+$/, "").trim()
  var used = usedAddresses(current + ",")
  var clean = cleanContact(contact)
  if (clean && used[clean.email.toLowerCase()]) return current
  return current + ", " + addr
}

function filter(values, query, limit) {
  var contacts = normalize(values)
  var q = String(query || "").trim().toLowerCase()
  var out = []
  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i]
    if (q === "" || c.email.toLowerCase().indexOf(q) >= 0 || c.name.toLowerCase().indexOf(q) >= 0) {
      out.push(c)
    }
  }
  out.sort(function(left, right) {
    var leftName = (left.name || left.email).toLowerCase()
    var rightName = (right.name || right.email).toLowerCase()
    return leftName < rightName ? -1 : (leftName > rightName ? 1 : 0)
  })
  if (typeof limit === "number" && limit > 0) {
    return out.slice(0, limit)
  }
  return out
}

