import QtQuick
import "People.js" as People

// Recipient suggestions. Local sources come from the backend's contacts.suggest
// (Thunderbird and Betterbird profiles, contacts.json/.vcf and cached mail),
// read without modifying them. Each Gmail account adds its Google Contacts
// (API 10), fetched at most every half hour: the address book changes slowly
// and each refresh is a few People API pages. A grant without the optional
// contacts scopes answers with an empty list.
QtObject {
  id: root

  required property var service
  property var contacts: []
  property bool loading: false
  property var local: []
  property var google: ({})
  property var fetched: ({})
  readonly property int maxAge: 30 * 60 * 1000

  // The address book view: one row per person rather than per address, with
  // phones, organisation and photo. Each Gmail account's saved contacts and
  // "Other contacts" (API 10), then any local address not already among them,
  // marked as neither saved nor Google's.
  property var people: []
  // Readings still out, one per Gmail account: the view is loading until the
  // last of them answers, not the first.
  property int peoplePending: 0
  readonly property bool peopleLoading: peoplePending > 0
  property var googlePeople: ({})
  property var peopleFetched: ({})

  // Only the local sources here: the address book's own read already holds
  // everything the suggestions' Google crawl would fetch again.
  function refreshLocal() {
    var backend = service.backend
    if (loading || !backend || !backend.ready) return
    loading = true
    backend.call("contacts.suggest", {}, function(result, error) {
      root.loading = false
      if (!error && Array.isArray(result)) {
        root.local = result
        root.merge()
        root.mergePeople()
      }
    })
  }

  function refreshPeople(force) {
    var backend = service.backend
    if (!backend || !backend.ready) return
    refreshLocal()
    if (!service.backendCanReadAddressBook) { mergePeople(); return }
    var accounts = service.accountList ? service.accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].provider === "gmail") refreshGooglePeople(accounts[i].id, force === true)
    }
    mergePeople()
  }

  function refreshGooglePeople(accountId, force) {
    if (!force && Date.now() - (peopleFetched[accountId] || 0) < maxAge) return
    var stamped = Object.assign({}, peopleFetched)
    stamped[accountId] = Date.now()
    peopleFetched = stamped
    peoplePending++
    service.backend.call("contacts.people", { accountId: accountId }, function(result, error) {
      root.peoplePending = Math.max(0, root.peoplePending - 1)
      if (error || !result || !Array.isArray(result.people)) {
        var retry = Object.assign({}, root.peopleFetched)
        delete retry[accountId]
        root.peopleFetched = retry
        return
      }
      var next = Object.assign({}, root.googlePeople)
      next[accountId] = result.people.map(function(person) {
        return Object.assign({}, person, { accountId: accountId })
      })
      root.googlePeople = next
      root.mergePeople()
    })
  }

  function mergePeople() {
    var seen = ({})
    var merged = []
    // Saved contacts first, across every account, then "Other contacts": a
    // person in both is the saved card, with its phone, company and photo.
    var candidates = []
    for (var account in googlePeople) candidates = candidates.concat(googlePeople[account])
    candidates = candidates.filter(function(p) { return p.saved === true })
      .concat(candidates.filter(function(p) { return p.saved !== true }))
    {
      var list = candidates
      for (var i = 0; i < list.length; i++) {
        var person = list[i]
        var emails = person.emails || []
        // The same person saved in two accounts, or saved and also among the
        // other contacts, is one row: the first address decides.
        var key = emails.length > 0 ? String(emails[0].value).toLowerCase() : "id:" + person.id
        if (seen[key]) continue
        for (var e = 0; e < emails.length; e++) seen[String(emails[e].value).toLowerCase()] = true
        seen[key] = true
        merged.push(person)
      }
    }
    for (var j = 0; j < local.length; j++) {
      var email = String(local[j].email || "")
      var lower = email.toLowerCase()
      if (lower === "" || seen[lower]) continue
      seen[lower] = true
      merged.push({ id: "local:" + lower, name: String(local[j].name || ""),
        emails: [{ value: email, type: "" }], phones: [], organization: "", title: "",
        photo: "", saved: false, accountId: "" })
    }
    merged.sort(People.compare)
    people = merged
  }

  function refresh() {
    var backend = service.backend
    if (loading || !backend || !backend.ready) return
    loading = true
    backend.call("contacts.suggest", {}, function(result, error) {
      root.loading = false
      if (!error && Array.isArray(result)) {
        root.local = result
        root.merge()
        if (root.people.length > 0 || root.peopleLoading) root.mergePeople()
      }
    })
    if (!service.backendCanSuggestGoogleContacts) return
    var accounts = service.accountList ? service.accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].provider === "gmail" && accounts[i].id) refreshGoogle(accounts[i].id)
    }
  }

  function refreshGoogle(accountId) {
    if (Date.now() - (fetched[accountId] || 0) < maxAge) return
    var stamped = Object.assign({}, fetched)
    stamped[accountId] = Date.now()
    fetched = stamped
    service.backend.call("contacts.google", { accountId: accountId }, function(result, error) {
      // Signed out, offline or too slow: the stamp stays, so the next try
      // waits maxAge too instead of following every compose window.
      if (error || !result || !Array.isArray(result.contacts)) return
      var next = Object.assign({}, root.google)
      next[accountId] = result.contacts
      root.google = next
      root.merge()
    })
  }

  // Local sources first (they carry the names Thunderbird learned), then the
  // Google Contacts of each Gmail account still registered; one row per
  // address, and a name beats no name.
  function merge() {
    var seen = ({})
    var merged = []
    function add(list) {
      for (var i = 0; i < list.length; i++) {
        var key = String(list[i].email || "").toLowerCase()
        if (key === "") continue
        if (seen[key] === undefined) {
          seen[key] = merged.length
          merged.push(list[i])
        } else if (!merged[seen[key]].name && list[i].name) {
          merged[seen[key]] = list[i]
        }
      }
    }
    add(local)
    var accounts = service.accountList ? service.accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      var listed = google[accounts[i].id]
      if (accounts[i].provider === "gmail" && Array.isArray(listed)) add(listed)
    }
    contacts = merged
  }
}
