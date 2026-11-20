import QtQuick
import "Accounts.js" as Accounts

// Recipient suggestions. Local sources come from the backend's contacts.suggest
// (Thunderbird and Betterbird profiles, contacts.json/.vcf and cached mail),
// read without modifying them. Each Gmail account adds its Google Contacts
// (API 10), fetched at most every half hour: the address book changes slowly
// and each refresh is a few People API pages. A grant without the optional
// contacts scopes answers with an empty list.
//
// An IMAP mailbox adds the address books on its own server (contacts.dav,
// API 10) once they have been found from Settings: the backend keeps a
// private snapshot, read here without the network and refreshed at most
// every half hour. Finding them is the person's choice because it signs in
// to the server's web address with the mailbox password.
QtObject {
  id: root

  required property var service
  property var contacts: []
  property bool loading: false
  property var local: []
  property var google: ({})
  property var fetched: ({})
  // accountId -> {state, books, contacts, fetchedAt, error}; state is
  // "off", "loading" or "on".
  property var mailbox: ({})
  // Mailboxes removed while the backend could not be asked to delete their
  // snapshot; it is asked as soon as it can be.
  property var owedForgets: []
  // Bumped by "Stop using" and by removal: a refresh that was already out
  // when it happened answers into nothing.
  property var forgetEpoch: ({})
  readonly property int maxAge: 30 * 60 * 1000
  readonly property bool canReadMailboxBooks: !!service && !!service.backend
    && service.backend.ready === true && Number(service.backend.apiVersion) >= 10

  // What each source contributes, for Settings: the local book, then one
  // entry per IMAP mailbox that can have address books on its server.
  readonly property var sources: {
    var values = [{ id: "local", count: local.length }]
    var accounts = service && service.accountList ? service.accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (!canHaveBooks(accounts[i])) continue
      var state = mailbox[accounts[i].id] || { state: "off" }
      values.push({
        id: accounts[i].id, email: String(accounts[i].email || accounts[i].id),
        state: state.state, books: state.books || [], fetchedAt: state.fetchedAt || 0,
        refreshing: state.refreshing === true,
        error: state.error || "", count: Array.isArray(state.contacts) ? state.contacts.length : 0,
        // The server finding them signs in to, named before the button is.
        host: Accounts.davHost(accounts[i])
      })
    }
    return values
  }

  function canHaveBooks(account) {
    return !!account && account.provider === "imap" && !!account.id
      && Accounts.calendarProvider(account) === "imap"
  }

  function hasMailbox(accountId) {
    var accounts = service && service.accountList ? service.accountList.accounts : []
    for (var i = 0; i < accounts.length; i++)
      if (accounts[i].id === accountId && canHaveBooks(accounts[i])) return true
    return false
  }

  onCanReadMailboxBooksChanged: flushForgets()

  function refresh() {
    var backend = service.backend
    if (loading || !backend || !backend.ready) return
    flushForgets()
    loading = true
    backend.call("contacts.suggest", {}, function(result, error) {
      root.loading = false
      if (!error && Array.isArray(result)) {
        root.local = result
        root.merge()
      }
    })
    var accounts = service.accountList ? service.accountList.accounts : []
    if (canReadMailboxBooks) {
      for (var m = 0; m < accounts.length; m++)
        if (canHaveBooks(accounts[m])) refreshMailbox(accounts[m].id, false)
    }
    if (!service.backendCanSuggestGoogleContacts) return
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

  function setMailbox(accountId, value) {
    var next = Object.assign({}, mailbox)
    next[accountId] = value
    mailbox = next
    merge()
  }

  function applyBooks(accountId, result, error) {
    var code = error ? String(error.message || error || "") : ""
    // The mailbox's server is not the one the books were found on: they are
    // gone, and finding them again names the new server.
    if (code === "contacts_server_changed") {
      setMailbox(accountId, { state: "off", error: code })
      return
    }
    if (error || !result) {
      var previous = mailbox[accountId] || {}
      setMailbox(accountId, Object.assign({}, previous, {
        state: previous.state === "on" ? "on" : "off", refreshing: false,
        error: String(error && error.message || error || "contacts_unavailable")
      }))
      return
    }
    if (result.enabled !== true) {
      setMailbox(accountId, { state: "off", error: String(result.error || "") })
      return
    }
    setMailbox(accountId, {
      state: "on", books: Array.isArray(result.books) ? result.books : [],
      contacts: Array.isArray(result.contacts) ? result.contacts : [],
      fetchedAt: Number(result.fetchedAt) || 0, error: String(result.error || "")
    })
  }

  // The saved snapshot first, without the network; the server only for a
  // mailbox already using its books, and no more than every maxAge.
  function refreshMailbox(accountId, force) {
    var key = "dav:" + accountId
    if (!force && Date.now() - (fetched[key] || 0) < maxAge) return
    var stamped = Object.assign({}, fetched)
    stamped[key] = Date.now()
    fetched = stamped
    // Refresh and Stop using wait while the saved copy is read too.
    var previous = mailbox[accountId] || { state: "off" }
    setMailbox(accountId, Object.assign({}, previous, { refreshing: true }))
    var epoch = forgetEpoch[accountId] || 0
    service.backend.call("contacts.dav", { accountId: accountId, operation: "read" }, function(result, error) {
      if (!root.hasMailbox(accountId)) return
      // Stopped while it was out: the answer is not used.
      if ((root.forgetEpoch[accountId] || 0) !== epoch) return
      root.applyBooks(accountId, result, error)
      if (error || !result || result.enabled !== true) return
      if (Date.now() - (Number(result.fetchedAt) || 0) < root.maxAge) return
      root.callRefresh(accountId)
    })
  }

  // `server` is the host the Find button named: the backend reads only that
  // one. Without it this is the background refresh of books already in use,
  // which the backend allows only for the server they were read from.
  function callRefresh(accountId, server) {
    var previous = mailbox[accountId] || { state: "off" }
    setMailbox(accountId, Object.assign({}, previous, {
      state: previous.state === "on" ? "on" : "loading", error: "", refreshing: true
    }))
    var epoch = forgetEpoch[accountId] || 0
    var params = { accountId: accountId, operation: "refresh" }
    if (server) params.server = server
    service.backend.call("contacts.dav", params, function(result, error) {
      // Removed while the server was being read: what that read saved goes too.
      if (!root.hasMailbox(accountId)) { root.mailboxRemoved(accountId); return }
      // Stopped while it was out: the answer is not used.
      if ((root.forgetEpoch[accountId] || 0) !== epoch) return
      root.applyBooks(accountId, result, error)
    })
  }

  // From Settings: look for the mailbox's address books now.
  function findBooks(accountId) {
    if (!canReadMailboxBooks) return false
    var state = mailbox[accountId] || { state: "off" }
    if (state.state === "loading" || state.refreshing === true) return false
    var accounts = service && service.accountList ? service.accountList.accounts : []
    var server = ""
    for (var i = 0; i < accounts.length; i++)
      if (accounts[i].id === accountId) server = Accounts.davHost(accounts[i])
    if (server === "") return false
    callRefresh(accountId, server)
    return true
  }

  function forgetBooks(accountId) {
    if (!canReadMailboxBooks) return false
    var epochs = Object.assign({}, forgetEpoch)
    epochs[accountId] = (epochs[accountId] || 0) + 1
    forgetEpoch = epochs
    service.backend.call("contacts.dav", { accountId: accountId, operation: "forget" }, function(result, error) {
      if (!error) root.setMailbox(accountId, { state: "off" })
    })
    return true
  }

  // Service is removing this mailbox (Service.qml is at its size ceiling, so
  // the rest happens here): once it is gone from the list, its books go too.
  function removing(account) {
    var id = String(account && account.id || "")
    Qt.callLater(function() { root.mailboxRemoved(id) })
  }

  // A removed mailbox takes its address books with it: the snapshot is
  // deleted, and the choice to read them is not kept for a mailbox added again
  // later under the same address. A mailbox still listed keeps its books.
  function mailboxRemoved(accountId) {
    var id = String(accountId || "")
    if (id.indexOf("imap:") !== 0 || hasMailbox(id)) return
    var next = Object.assign({}, mailbox)
    delete next[id]
    mailbox = next
    var epochs = Object.assign({}, forgetEpoch)
    epochs[id] = (epochs[id] || 0) + 1
    forgetEpoch = epochs
    var stamped = Object.assign({}, fetched)
    delete stamped["dav:" + id]
    fetched = stamped
    merge()
    if (owedForgets.indexOf(id) < 0) owedForgets = owedForgets.concat([id])
    flushForgets()
  }

  function flushForgets() {
    if (!canReadMailboxBooks) return
    var owed = owedForgets
    for (var i = 0; i < owed.length; i++) {
      (function(id) {
        root.service.backend.call("contacts.dav", { accountId: id, operation: "forget" }, function(result, error) {
          if (!error) root.owedForgets = root.owedForgets.filter(function(value) { return value !== id })
        })
      })(owed[i])
    }
  }

  // Local sources first (they carry the names Thunderbird learned), then the
  // Google Contacts of each Gmail account and the address books of each IMAP
  // mailbox still registered; one row per address, and a name beats no name.
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
      var books = mailbox[accounts[i].id]
      if (canHaveBooks(accounts[i]) && books && books.state === "on" && Array.isArray(books.contacts))
        add(books.contacts)
    }
    contacts = merged
  }
}
