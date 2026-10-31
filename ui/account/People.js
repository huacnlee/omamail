.pragma library

// The address book's rows, as the Contacts view reads them. A person is
// `{id, name, emails:[{value,type}], phones:[{value,type}], organization,
// title, photo, saved, accountId}`; see contacts.people and ContactBook.qml.

function firstEmail(person) {
  var emails = person && person.emails ? person.emails : []
  return emails.length > 0 ? String(emails[0].value || "") : ""
}

function firstPhone(person) {
  var phones = person && person.phones ? person.phones : []
  return phones.length > 0 ? String(phones[0].value || "") : ""
}

// What a row is called: the name, else the company (a number saved as
// "Proximus" is Proximus), else the address, else the first phone.
function displayName(person) {
  if (!person) return ""
  var name = String(person.name || "").trim()
  if (name !== "") return name
  var organization = String(person.organization || "").trim()
  if (organization !== "") return organization
  var email = firstEmail(person)
  if (email !== "") return email
  var phones = person.phones || []
  return phones.length > 0 ? String(phones[0].value || "") : ""
}

// The line under the name in the list: what the title did not already say.
function subtitle(person) {
  if (!person) return ""
  var title = displayName(person)
  var candidates = [String(person.organization || ""), firstEmail(person), firstPhone(person)]
  for (var i = 0; i < candidates.length; i++)
    if (candidates[i] !== "" && candidates[i] !== title) return candidates[i]
  return ""
}

// Letters before digits and symbols, then by name, the way a phone sorts
// its address book: the numbers nobody named go to the end.
function compare(a, b) {
  var x = displayName(a).toLowerCase()
  var y = displayName(b).toLowerCase()
  var xl = /^[a-z\u00c0-\u024f]/.test(x)
  var yl = /^[a-z\u00c0-\u024f]/.test(y)
  if (xl !== yl) return xl ? -1 : 1
  return x.localeCompare(y)
}

// One or two letters for the round badge a person without a photo gets.
function initials(person) {
  var words = displayName(person).replace(/[@.].*$/, "").split(/[\s_-]+/).filter(function(w) {
    return w.length > 0
  })
  if (words.length === 0) return "?"
  var first = words[0].charAt(0)
  var last = words.length > 1 ? words[words.length - 1].charAt(0) : ""
  return (first + last).toUpperCase()
}

// A query matches a name, any address, any phone (digits only, so spacing in
// a stored number does not matter) or the organisation. `savedOnly` keeps the
// contacts the person saved, as Outlook's People list does by default.
function filter(people, query, savedOnly) {
  var list = Array.isArray(people) ? people : []
  var q = String(query || "").trim().toLowerCase()
  var digits = q.replace(/[^0-9]/g, "")
  return list.filter(function(person) {
    if (!person) return false
    if (savedOnly && person.saved !== true) return false
    if (q === "") return true
    if (String(person.name || "").toLowerCase().indexOf(q) >= 0) return true
    if (String(person.organization || "").toLowerCase().indexOf(q) >= 0) return true
    var emails = person.emails || []
    for (var i = 0; i < emails.length; i++)
      if (String(emails[i].value || "").toLowerCase().indexOf(q) >= 0) return true
    if (digits.length >= 3) {
      var phones = person.phones || []
      for (var j = 0; j < phones.length; j++)
        if (String(phones[j].value || "").replace(/[^0-9]/g, "").indexOf(digits) >= 0) return true
    }
    return false
  })
}

// "Ada Lovelace <ada@example.com>", or the bare address, for a draft's To.
function recipient(person, email) {
  var address = String(email || firstEmail(person))
  if (address === "") return ""
  var name = String(person && person.name || "").replace(/["<>]/g, "").trim()
  return name !== "" ? name + " <" + address + ">" : address
}

// The letter a row is filed under, for the list's section headers.
function section(person) {
  var c = displayName(person).charAt(0).toUpperCase()
  return /[A-Z]/.test(c) ? c : "#"
}
