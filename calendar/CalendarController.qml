import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Calendar.js" as Calendar
import "Sources.js" as Sources
import "../message/Message.js" as Mail
import "../providers/Secrets.js" as Secrets

Item {
  id: root

  required property var service
  required property string pluginDir
  property string cacheName: "calendar"
  property string accountId: ""
  property var sourceList: Sources.emptyList()
  property bool sourcesLoaded: false
  property var events: []
  property bool loading: false
  property string lastError: ""
  property string lastErrorKind: ""
  property double rangeStart: 0
  property double rangeEnd: 0
  property double pendingRangeStart: 0
  property double pendingRangeEnd: 0
  property string refreshAccountId: ""
  // The scope an answer belongs to, which is not always the mailbox.
  //
  // The cache is keyed by it and an in-flight refresh is checked against it, so
  // it has to name what the visible calendar actually depends on. In the
  // default mode that is the account; in the unified mode the same sources are
  // shown whichever mailbox is open, so the account is not part of the
  // question — keying by it stored one copy of the same events per account,
  // spent the eight-range budget three times over, and made every mailbox
  // switch a cache miss: the calendar blanked and every account's calendars
  // were fetched again to redraw what was already on screen.
  property string refreshScope: ""
  property var queue: []
  property var activeSource: null
  property string lookedUpPassword: ""
  property bool lookupHandled: false
  property var googleRequest: null
  property bool googleRequestTimedOut: false
  property var passwordSaveQueue: []
  property string passwordToSave: ""
  property bool savingPassword: false
  property string sourceWritePayload: ""
  property string sourceSecret: ""
  property var sourceBeingSaved: null
  property bool savingSource: false
  property bool clockRunning: false
  property double nowMs: Date.now()
  property bool refreshAfterSourceWrite: false
  property bool creatingEvent: false
  property var eventSource: null
  property var eventDraft: null
  property var eventRequest: null
  property bool eventRequestTimedOut: false
  // One write at a time, create or otherwise: the password lookup, the writer
  // and the deadline all hold one operation's state, so update and delete
  // share this guard with create rather than growing their own.
  property string writeOp: ""
  property var writeSource: null
  property var writeEvent: null
  property var writeDraft: null
  // The address the current CalDAV write goes to, judged before the keyring
  // is touched and carried to the writer that runs after it.
  property string writeUrl: ""
  property bool eventWriting: false
  readonly property var availableSources: Sources.withGoogleAccounts(
    sourceList, service ? service.accountSummaries : [])
  readonly property bool unifiedCalendarView: !!service
    && service.unifiedCalendarView === true
  readonly property var contextSources: unifiedCalendarView
    ? availableSources : Sources.forAccount(availableSources, accountId)
  // One name for every mailbox, because the unified view is one view.
  //
  // A controller with no account is already showing every source — the bar
  // preview is one, and `Sources.forAccount(list, "")` has always returned all
  // of them — so the setting cannot change what it shows, and renaming its
  // scope would orphan a cache entry and refetch every calendar to redraw what
  // was already there.
  readonly property string calendarScope: unifiedCalendarView && accountId !== ""
    ? "__unified__" : accountId
  readonly property var sourceGroups: Sources.groupByAccount(
    contextSources, service ? service.accountSummaries : [])
  // The composer offers only calendars a write can run against.
  readonly property var writableSourceGroups: Sources.writableGroups(sourceGroups)

  Timer {
    interval: 60000
    repeat: true
    running: root.clockRunning
    triggeredOnStart: true
    onTriggered: root.nowMs = Date.now()
  }

  // The one event worth reloading for, said once: what is on screen depends on
  // the scope, so it is a change of scope that makes the answer stale. A
  // mailbox switch under the unified view is not one, and neither is turning
  // the setting on for a controller that had no mailbox to follow — watching
  // the two inputs separately got both of those wrong in opposite directions.
  onCalendarScopeChanged: reloadVisibleRange()

  // No `eventCache.loaded` guard, and it is not missing. `refresh` refuses on
  // an unloaded cache and `eventCache.onRestored` runs one as soon as it is
  // there, so the only thing the guard changed was whether an empty list was
  // assigned to a property that could not yet hold anything else: nothing can
  // have been fetched before the cache loaded, because fetching needs it too.
  function reloadVisibleRange() {
    if (!rangeStart || !rangeEnd) return
    events = cachedEventsFor(calendarScope, rangeStart, rangeEnd)
    refresh(rangeStart, rangeEnd)
  }

  signal passwordSaved(bool ok, string error)
  signal calendarSaved(bool ok, string error)
  signal eventCreated(bool ok, string error)
  signal eventUpdated(bool ok, string error)
  signal eventDeleted(bool ok, string error)

  readonly property string configPath: {
    var home = Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")
    return home + "/omamail/calendars.json"
  }

  function refresh(startMs, endMs) {
    var requestedStart = Number(startMs) || 0
    var requestedEnd = Number(endMs) || 0
    if (loading) {
      pendingRangeStart = requestedStart
      pendingRangeEnd = requestedEnd
      return
    }
    pendingRangeStart = 0
    pendingRangeEnd = 0
    rangeStart = requestedStart
    rangeEnd = requestedEnd
    if (!eventCache.loaded) return
    lastError = ""
    lastErrorKind = ""
    refreshAccountId = accountId
    refreshScope = calendarScope
    var effectiveSources = sourcesForAccount(refreshAccountId)
    queue = effectiveSources.sources.filter(function(source) {
      return source && source.enabled
    })
    var sourceIds = queue.map(function(source) { return String(source.id || "") })
    events = eventCache.get(refreshScope, rangeStart, rangeEnd, sourceIds)
    loading = true
    processNext()
  }

  function sourcesForAccount(wantedAccountId) {
    var available = Sources.withGoogleAccounts(
      sourceList, service ? service.accountSummaries : [])
    return unifiedCalendarView ? available : Sources.forAccount(available, wantedAccountId)
  }

  // `scope` rather than an account id: in the unified view every mailbox reads
  // the same entry, and asking for it by account would find nothing.
  function cachedEventsFor(scope, startMs, endMs) {
    var values = sourcesForAccount(accountId).sources.filter(function(source) {
      return source && source.enabled
    })
    return eventCache.get(scope, startMs, endMs,
      values.map(function(source) { return String(source.id || "") }))
  }

  function findSource(sourceId) {
    var values = contextSources.sources
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) return values[i]
    }
    return null
  }

  function createEvent(sourceId, fields) {
    if (creatingEvent || eventWriting) {
      eventCreated(false, "Another event change is still in progress")
      return false
    }
    var source = findSource(sourceId)
    var refusal = Calendar.writeRefusal(source, null)
    if (refusal !== "") { eventCreated(false, refusal); return false }
    var built = Calendar.createEvent(fields, Date.now())
    if (!built.ok) { eventCreated(false, built.error); return false }
    eventSource = source
    eventDraft = built
    creatingEvent = true
    if (source.kind === "google") createGoogleEvent()
    else {
      eventPasswordLookup.command = ["secret-tool", "lookup"]
        .concat(Sources.keyringAttributes(source.id))
      eventPasswordLookup.running = true
    }
    return true
  }

  function finishEvent(ok, error) {
    eventDeadline.stop()
    creatingEvent = false
    eventSource = null
    eventDraft = null
    eventRequest = null
    eventRequestTimedOut = false
    eventCreated(ok, String(error || ""))
    if (ok && rangeStart && rangeEnd) refresh(rangeStart, rangeEnd)
  }

  function updateEvent(sourceId, event, fields) {
    if (creatingEvent || eventWriting) {
      eventUpdated(false, "Another event change is still in progress")
      return false
    }
    var source = findSource(sourceId)
    var refusal = Calendar.writeRefusal(source, event)
    if (refusal !== "") { eventUpdated(false, refusal); return false }
    var built = Calendar.updateEvent(fields, event, Date.now())
    if (!built.ok) { eventUpdated(false, built.error); return false }
    writeOp = "update"
    writeSource = source
    writeEvent = event
    writeDraft = built
    eventWriting = true
    if (source.kind === "google") startGoogleWrite()
    else startCaldavWrite()
    return true
  }

  function deleteEvent(sourceId, event) {
    if (creatingEvent || eventWriting) {
      eventDeleted(false, "Another event change is still in progress")
      return false
    }
    var source = findSource(sourceId)
    var refusal = Calendar.writeRefusal(source, event)
    if (refusal !== "") { eventDeleted(false, refusal); return false }
    writeOp = "delete"
    writeSource = source
    writeEvent = event
    writeDraft = null
    eventWriting = true
    if (source.kind === "google") startGoogleWrite()
    else startCaldavWrite()
    return true
  }

  function finishWrite(ok, error) {
    var op = writeOp
    eventDeadline.stop()
    eventWriting = false
    writeOp = ""
    writeSource = null
    writeEvent = null
    writeDraft = null
    writeUrl = ""
    eventRequest = null
    eventRequestTimedOut = false
    if (op === "delete") eventDeleted(ok, String(error || ""))
    else eventUpdated(ok, String(error || ""))
    // A delete is asked for from the detail, not the composer, so nothing
    // else is listening: the failure has to land on the view's own banner.
    if (!ok) {
      lastError = String(error || "Could not write the event")
      lastErrorKind = ""
    }
    if (ok && rangeStart && rangeEnd) refresh(rangeStart, rangeEnd)
  }

  function startGoogleWrite() {
    var eventId = String(writeEvent && writeEvent.googleId || "")
    if (eventId === "") { finishWrite(false, "This event has no Google id to write against"); return }
    service.withGoogleAccessToken(writeSource.accountId, function(token, error) {
      if (!token) { root.finishWrite(false, error); return }
      var request = new XMLHttpRequest()
      root.eventRequest = request
      root.eventRequestTimedOut = false
      if (root.writeOp === "delete") {
        request.open("DELETE", Calendar.googleEventUrl(eventId))
      } else {
        request.open("PATCH", Calendar.googleEventUrl(eventId))
        request.setRequestHeader("Content-Type", "application/json")
      }
      request.setRequestHeader("Authorization", "Bearer " + token)
      request.onreadystatechange = function() {
        if (request.readyState !== XMLHttpRequest.DONE) return
        eventDeadline.stop()
        root.eventRequest = null
        var timedOut = root.eventRequestTimedOut
        root.eventRequestTimedOut = false
        if (request.status < 200 || request.status >= 300) {
          root.finishWrite(false, timedOut
            ? "The Google Calendar event request timed out"
            : Calendar.googleResponseError(request.status, request.responseText))
          return
        }
        root.finishWrite(true, "")
      }
      eventDeadline.restart()
      if (root.writeOp === "delete") request.send()
      else request.send(JSON.stringify(root.writeDraft.google))
      token = ""
    })
  }

  // The address is judged before the keyring is touched: a write URL that
  // does not resolve to the source's own origin stops the operation here,
  // not after a password has been read for it.
  function startCaldavWrite() {
    var url = Calendar.caldavEventUrl(writeSource ? writeSource.url : "", writeEvent)
    if (url === "") {
      finishWrite(false, "The event's address is outside this calendar's server")
      return
    }
    writeUrl = url
    caldavWritePasswordLookup.command = ["secret-tool", "lookup"]
      .concat(Sources.keyringAttributes(writeSource.id))
    caldavWritePasswordLookup.running = true
  }

  function createGoogleEvent() {
    service.withGoogleAccessToken(eventSource.accountId, function(token, error) {
      if (!token) { root.finishEvent(false, error); return }
      var request = new XMLHttpRequest()
      root.eventRequest = request
      root.eventRequestTimedOut = false
      request.open("POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events")
      request.setRequestHeader("Authorization", "Bearer " + token)
      request.setRequestHeader("Content-Type", "application/json")
      request.onreadystatechange = function() {
        if (request.readyState !== XMLHttpRequest.DONE) return
        eventDeadline.stop()
        root.eventRequest = null
        var timedOut = root.eventRequestTimedOut
        root.eventRequestTimedOut = false
        if (request.status < 200 || request.status >= 300) {
          root.finishEvent(false, timedOut
            ? "The Google Calendar event request timed out"
            : Calendar.googleResponseError(request.status, request.responseText))
          return
        }
        root.finishEvent(true, "")
      }
      eventDeadline.restart()
      request.send(JSON.stringify(root.eventDraft.google))
      token = ""
    })
  }

  function saveCalDavPassword(secret) {
    var password = String(secret || "")
    if (password === "") { passwordSaved(false, "Enter the calendar password"); return }
    var values = sourceList && Array.isArray(sourceList.sources) ? sourceList.sources : []
    var targets = []
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].kind === "caldav") targets.push(values[i])
    }
    if (targets.length === 0) { passwordSaved(false, "No CalDAV calendars are configured"); return }
    passwordToSave = password
    password = ""
    passwordSaveQueue = targets
    savingPassword = true
    storeNextPassword()
  }

  function addCalDavCalendar(raw, secret) {
    if (savingSource) return
    var candidate = raw || {}
    candidate.kind = "caldav"
    candidate.id = Sources.sourceId(candidate)
    candidate.enabled = true
    var checked = Sources.validate(candidate)
    if (!checked.ok) { calendarSaved(false, checked.error); return }
    if (String(secret || "") === "") {
      calendarSaved(false, "Add the calendar password")
      return
    }
    sourceBeingSaved = checked.source
    sourceSecret = String(secret)
    sourceWritePayload = Sources.serialize(Sources.add(sourceList, checked.source))
    savingSource = true
    sourceWriter.command = [pluginDir + "/scripts/config-store.sh", "calendars.json"]
    sourceWriter.running = true
  }

  function removeCalendar(sourceId) {
    if (savingSource) return
    sourceBeingSaved = null
    sourceSecret = ""
    sourceWritePayload = Sources.serialize(Sources.remove(sourceList, sourceId))
    refreshAfterSourceWrite = true
    savingSource = true
    sourceWriter.command = [pluginDir + "/scripts/config-store.sh", "calendars.json"]
    sourceWriter.running = true
  }

  function setSourceEnabled(sourceId, enabled) {
    if (savingSource) return
    var values = availableSources && Array.isArray(availableSources.sources)
      ? availableSources.sources : []
    var source = null
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) { source = values[i]; break }
    }
    if (!source) return
    var next = Sources.add(sourceList, source)
    next = Sources.setEnabled(next, source.id, enabled)
    sourceBeingSaved = null
    sourceSecret = ""
    sourceWritePayload = Sources.serialize(next)
    refreshAfterSourceWrite = true
    savingSource = true
    sourceWriter.command = [pluginDir + "/scripts/config-store.sh", "calendars.json"]
    sourceWriter.running = true
  }

  function colorKeyFor(sourceId) {
    var values = availableSources && Array.isArray(availableSources.sources)
      ? availableSources.sources : []
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) return values[i].colorKey
    }
    return Sources.defaultColorKey(sourceId)
  }

  function setSourceColor(sourceId, colorKey) {
    if (savingSource) return
    var values = availableSources && Array.isArray(availableSources.sources)
      ? availableSources.sources : []
    var source = null
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) { source = values[i]; break }
    }
    if (!source) return
    var next = Sources.add(sourceList, source)
    next = Sources.setColor(next, source.id, colorKey)
    sourceBeingSaved = null
    sourceSecret = ""
    sourceWritePayload = Sources.serialize(next)
    refreshAfterSourceWrite = false
    savingSource = true
    sourceWriter.command = [pluginDir + "/scripts/config-store.sh", "calendars.json"]
    sourceWriter.running = true
  }

  function updateCalendarPassword(source, secret) {
    if (savingSource) return
    if (!source || source.kind !== "caldav") {
      calendarSaved(false, "Choose a CalDAV calendar")
      return
    }
    if (String(secret || "") === "") {
      calendarSaved(false, "Add the calendar password")
      return
    }
    sourceBeingSaved = source
    sourceSecret = String(secret)
    savingSource = true
    sourcePasswordStore.command = [pluginDir + "/scripts/keyring-store.sh"]
      .concat(Sources.keyringAttributes(source.id))
    sourcePasswordStore.running = true
  }

  function storeNextPassword() {
    if (passwordSaveQueue.length === 0) {
      passwordToSave = ""
      savingPassword = false
      passwordSaved(true, "")
      if (rangeStart && rangeEnd) refresh(rangeStart, rangeEnd)
      return
    }
    var pending = passwordSaveQueue.slice()
    var source = pending.shift()
    passwordSaveQueue = pending
    var attributes = Sources.keyringAttributes(source.id)
    passwordStore.command = [pluginDir + "/scripts/keyring-store.sh"].concat(attributes)
    passwordStore.running = true
  }

  function replaceActiveSourceEvents(values) {
    if (refreshScope !== calendarScope) return
    var sourceId = activeSource ? String(activeSource.id || "") : ""
    var next = events.filter(function(event) {
      return String(event && event.sourceId || "") !== sourceId
    })
    var additions = Array.isArray(values) ? values : []
    for (var i = 0; i < additions.length; i++) {
      additions[i].sourceName = activeSource
        ? String(activeSource.name || activeSource.id || "Calendar") : "Calendar"
      next.push(additions[i])
    }
    next.sort(Calendar.compareEvents)
    events = next
  }

  function failSource(reason, kind) {
    if (refreshScope !== calendarScope) { processNext(); return }
    var name = activeSource ? activeSource.name || activeSource.id : "Calendar"
    lastError = name + ": " + String(reason || "Could not load events")
    lastErrorKind = String(kind || "")
    processNext()
  }

  function processNext() {
    if (queue.length === 0) {
      activeSource = null
      loading = false
      var enabled = sourcesForAccount(refreshAccountId).sources.filter(function(source) {
        return source && source.enabled
      }).map(function(source) { return String(source.id || "") })
      var allowed = {}
      for (var i = 0; i < enabled.length; i++) allowed[enabled[i]] = true
      if (refreshScope === calendarScope) events = events.filter(function(event) {
        return allowed[String(event && event.sourceId || "")] === true
      })
      if (rangeStart && rangeEnd && refreshScope === calendarScope)
        eventCache.put(refreshScope, rangeStart, rangeEnd, events)
      var nextStart = pendingRangeStart
      var nextEnd = pendingRangeEnd
      pendingRangeStart = 0
      pendingRangeEnd = 0
      if (nextStart && nextEnd)
        Qt.callLater(function() { root.refresh(nextStart, nextEnd) })
      return
    }
    var pending = queue.slice()
    activeSource = pending.shift()
    queue = pending
    if (activeSource.kind === "google") startGoogle()
    else if (activeSource.kind === "caldav") startPasswordLookup()
    else failSource("The HEY CLI does not expose calendar events")
  }

  function startPasswordLookup() {
    var attributes = Sources.keyringAttributes(activeSource.id)
    if (attributes.length === 0) { failSource("The calendar source has no id"); return }
    lookupHandled = false
    lookedUpPassword = ""
    passwordLookup.command = ["secret-tool", "lookup"].concat(attributes)
    passwordLookup.running = true
  }

  function handlePassword(value) {
    if (lookupHandled) return
    lookupHandled = true
    lookedUpPassword = String(value || "")
    if (lookedUpPassword === "") { failSource("Add this calendar's password in Settings"); return }
    var report = Calendar.caldavReport(rangeStart, rangeEnd)
    var credentials = activeSource.username + ":" + lookedUpPassword
    calendarTransport.command = [pluginDir + "/scripts/calendar-transport.sh"]
    calendarTransport.requestLine = Mail.encodeBase64(activeSource.url) + " "
      + Mail.encodeBase64(credentials) + " " + Mail.encodeBase64(report) + "\n"
    credentials = ""
    lookedUpPassword = ""
    calendarTransport.running = true
  }

  function startGoogle() {
    if (!service || typeof service.withGoogleAccessToken !== "function") {
      failSource("Google calendar access is unavailable")
      return
    }
    service.withGoogleAccessToken(activeSource.accountId, function(token, error) {
      if (!token) { root.failSource(error); return }
      var request = new XMLHttpRequest()
      root.googleRequest = request
      root.googleRequestTimedOut = false
      request.open("GET", Calendar.googleEventsUrl(root.rangeStart, root.rangeEnd))
      request.setRequestHeader("Authorization", "Bearer " + token)
      request.onreadystatechange = function() {
        if (request.readyState !== XMLHttpRequest.DONE) return
        googleDeadline.stop()
        root.googleRequest = null
        var timedOut = root.googleRequestTimedOut
        root.googleRequestTimedOut = false
        if (request.status < 200 || request.status >= 300) {
          var reason = timedOut
            ? "The Google Calendar request timed out"
            : Calendar.googleResponseError(request.status, request.responseText)
          root.failSource(reason, !timedOut
              && Calendar.isGoogleCalendarApiDisabledError(reason)
            ? "googleApiDisabled" : "")
          return
        }
        var payload = null
        try { payload = JSON.parse(request.responseText) } catch (e) {}
        if (!payload) { root.failSource("Google Calendar returned an unreadable response"); return }
        root.replaceActiveSourceEvents(Calendar.eventsFromGoogle(payload, root.activeSource.id))
        root.processNext()
      }
      googleDeadline.restart()
      request.send()
      token = ""
    })
  }

  FileView {
    path: root.configPath
    watchChanges: true
    printErrors: false
    onLoaded: {
      var firstLoad = !root.sourcesLoaded
      root.sourceList = Sources.load(text())
      root.sourcesLoaded = true
      if (firstLoad && root.rangeStart && root.rangeEnd) root.refresh(root.rangeStart, root.rangeEnd)
    }
    onFileChanged: reload()
    onLoadFailed: {
      root.sourceList = Sources.emptyList()
      root.sourcesLoaded = true
    }
  }

  Process {
    id: passwordLookup
    // `secret-tool lookup` writes the secret with no trailing newline, so a
    // SplitParser splitting on one never fires its read at all: the password
    // was found, the callback was not, and the source reported itself as
    // having no password saved. The whole output, read when the process is
    // done with, is the same answer without depending on how it ends —
    // which is what `eventPasswordLookup` below already does.
    stdout: StdioCollector { id: passwordLookupOutput; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      // No entry is not an error: it is what a source that has never been
      // given a password looks like.
      root.handlePassword(exitCode === 0 ? Secrets.fromKeyring(passwordLookupOutput.text) : "")
    }
  }

  Process {
    id: passwordStore
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { id: passwordStoreError; waitForEnd: true }
    onStarted: write(root.passwordToSave + "\n")
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.passwordToSave = ""
        root.passwordSaveQueue = []
        root.savingPassword = false
        root.passwordSaved(false, String(passwordStoreError.text || "Could not save the password"))
        return
      }
      root.storeNextPassword()
    }
  }

  Process {
    id: sourceWriter
    stdinEnabled: true
    stderr: StdioCollector { id: sourceWriteError; waitForEnd: true }
    onStarted: write(root.sourceWritePayload + "\n")
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.savingSource = false
        root.sourceSecret = ""
        root.refreshAfterSourceWrite = false
        root.calendarSaved(false, String(sourceWriteError.text || "Could not save the calendar"))
        return
      }
      root.sourceList = Sources.load(root.sourceWritePayload)
      if (!root.sourceBeingSaved) {
        root.savingSource = false
        root.calendarSaved(true, "")
        if (root.refreshAfterSourceWrite && root.rangeStart && root.rangeEnd)
          root.refresh(root.rangeStart, root.rangeEnd)
        root.refreshAfterSourceWrite = false
        return
      }
      sourcePasswordStore.command = [root.pluginDir + "/scripts/keyring-store.sh"]
        .concat(Sources.keyringAttributes(root.sourceBeingSaved.id))
      sourcePasswordStore.running = true
    }
  }

  Process {
    id: sourcePasswordStore
    stdinEnabled: true
    stderr: StdioCollector { id: sourcePasswordError; waitForEnd: true }
    onStarted: write(root.sourceSecret + "\n")
    onExited: function(exitCode) {
      root.sourceSecret = ""
      root.sourceBeingSaved = null
      root.savingSource = false
      if (exitCode !== 0) {
        root.calendarSaved(false, String(sourcePasswordError.text || "Could not save the password"))
        return
      }
      root.calendarSaved(true, "")
      if (root.rangeStart && root.rangeEnd) root.refresh(root.rangeStart, root.rangeEnd)
    }
  }

  Process {
    id: calendarTransport
    property string requestLine: ""
    stdinEnabled: true
    stdout: StdioCollector { id: transportOutput; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(requestLine)
      requestLine = ""
    }
    onExited: function(exitCode) {
      var lines = String(transportOutput.text || "").split("\n")
      var status = Number(lines[0])
      var body = lines.length > 1 ? Mail.decodeBase64Url(lines[1].replace(/\+/g, "-").replace(/\//g, "_")) : ""
      if (exitCode !== 0 || status !== 0) { root.failSource("The CalDAV request failed"); return }
      root.replaceActiveSourceEvents(Calendar.eventsFromCaldav(
        body, root.activeSource.id, root.rangeStart, root.rangeEnd))
      root.processNext()
    }
  }

  Process {
    id: eventPasswordLookup
    stdout: StdioCollector { id: eventPasswordOutput; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      var password = String(eventPasswordOutput.text || "").trim()
      if (exitCode !== 0 || password === "") {
        root.finishEvent(false, "Set this calendar's password in Settings")
        return
      }
      var base = String(root.eventSource.url || "")
      if (base.charAt(base.length - 1) !== "/") base += "/"
      var url = base + encodeURIComponent(root.eventDraft.uid) + ".ics"
      var credentials = root.eventSource.username + ":" + password
      eventWriter.command = [root.pluginDir + "/scripts/calendar-write.sh"]
      eventWriter.requestLine = Mail.encodeBase64(url) + " "
        + Mail.encodeBase64(credentials) + " " + Mail.encodeBase64(root.eventDraft.ics) + "\n"
      password = ""
      credentials = ""
      eventWriter.running = true
    }
  }

  Process {
    id: eventWriter
    property string requestLine: ""
    stdinEnabled: true
    stderr: StdioCollector { id: eventWriteError; waitForEnd: true }
    onStarted: { write(requestLine); requestLine = "" }
    onExited: function(exitCode) {
      root.finishEvent(exitCode === 0,
        exitCode === 0 ? "" : String(eventWriteError.text || "Could not create the event"))
    }
  }

  Process {
    id: caldavWritePasswordLookup
    stdout: StdioCollector { id: writePasswordOutput; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      var password = String(writePasswordOutput.text || "").trim()
      if (exitCode !== 0 || password === "") {
        root.finishWrite(false, "Set this calendar's password in Settings")
        return
      }
      // The URL was resolved and judged in startCaldavWrite, before this
      // lookup ran; here it is only read back.
      var url = root.writeUrl
      var credentials = root.writeSource.username + ":" + password
      if (root.writeOp === "delete") {
        eventDeleter.command = [root.pluginDir + "/scripts/calendar-delete.sh"]
        eventDeleter.requestLine = Mail.encodeBase64(url) + " "
          + Mail.encodeBase64(credentials) + "\n"
        eventDeleter.running = true
      } else {
        caldavEventUpdater.command = [root.pluginDir + "/scripts/calendar-write.sh"]
        caldavEventUpdater.requestLine = Mail.encodeBase64(url) + " "
          + Mail.encodeBase64(credentials) + " " + Mail.encodeBase64(root.writeDraft.ics) + "\n"
        caldavEventUpdater.running = true
      }
      password = ""
      credentials = ""
    }
  }

  Process {
    id: caldavEventUpdater
    property string requestLine: ""
    stdinEnabled: true
    stderr: StdioCollector { id: eventUpdateError; waitForEnd: true }
    onStarted: { write(requestLine); requestLine = "" }
    onExited: function(exitCode) {
      root.finishWrite(exitCode === 0,
        exitCode === 0 ? "" : String(eventUpdateError.text || "Could not update the event"))
    }
  }

  Process {
    id: eventDeleter
    property string requestLine: ""
    stdinEnabled: true
    stderr: StdioCollector { id: eventDeleteError; waitForEnd: true }
    onStarted: { write(requestLine); requestLine = "" }
    onExited: function(exitCode) {
      root.finishWrite(exitCode === 0,
        exitCode === 0 ? "" : String(eventDeleteError.text || "Could not delete the event"))
    }
  }

  Timer {
    id: googleDeadline
    interval: 60000
    onTriggered: {
      if (!root.googleRequest) return
      root.googleRequestTimedOut = true
      root.googleRequest.abort()
    }
  }

  CalendarCache {
    id: eventCache
    cacheName: root.cacheName
    onRestored: {
      if (root.rangeStart && root.rangeEnd && !root.loading)
        root.refresh(root.rangeStart, root.rangeEnd)
    }
  }

  Timer {
    id: eventDeadline
    interval: 60000
    onTriggered: {
      if (!root.eventRequest) return
      root.eventRequestTimedOut = true
      root.eventRequest.abort()
    }
  }
}
