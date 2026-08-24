import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Calendar.js" as Calendar
import "Sources.js" as Sources
import "../message/Message.js" as Mail

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
  property var queue: []
  property var activeSource: null
  property string lookedUpPassword: ""
  property bool lookupHandled: false
  property var googleRequest: null
  property var passwordSaveQueue: []
  property string passwordToSave: ""
  property bool savingPassword: false
  property string sourceWritePayload: ""
  property string sourceSecret: ""
  property var sourceBeingSaved: null
  property bool savingSource: false
  property bool refreshAfterSourceWrite: false
  property bool creatingEvent: false
  property var eventSource: null
  property var eventDraft: null
  property var eventRequest: null
  readonly property var availableSources: Sources.withGoogleAccounts(
    sourceList, service ? service.accountSummaries : [])
  readonly property var contextSources: Sources.forAccount(availableSources, accountId)
  readonly property var sourceGroups: Sources.groupByAccount(
    contextSources, service ? service.accountSummaries : [])

  onAccountIdChanged: {
    if (!rangeStart || !rangeEnd || !eventCache.loaded) return
    events = cachedEventsFor(accountId, rangeStart, rangeEnd)
    refresh(rangeStart, rangeEnd)
  }

  signal passwordSaved(bool ok, string error)
  signal calendarSaved(bool ok, string error)
  signal eventCreated(bool ok, string error)

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
    var effectiveSources = sourcesForAccount(refreshAccountId)
    queue = effectiveSources.sources.filter(function(source) {
      return source && source.enabled
    })
    var sourceIds = queue.map(function(source) { return String(source.id || "") })
    events = eventCache.get(refreshAccountId, rangeStart, rangeEnd, sourceIds)
    loading = true
    processNext()
  }

  function sourcesForAccount(wantedAccountId) {
    return Sources.forAccount(Sources.withGoogleAccounts(
      sourceList, service ? service.accountSummaries : []), wantedAccountId)
  }

  function cachedEventsFor(wantedAccountId, startMs, endMs) {
    var values = sourcesForAccount(wantedAccountId).sources.filter(function(source) {
      return source && source.enabled
    })
    return eventCache.get(wantedAccountId, startMs, endMs,
      values.map(function(source) { return String(source.id || "") }))
  }

  function createEvent(sourceId, fields) {
    if (creatingEvent) return
    var values = contextSources.sources
    var source = null
    for (var i = 0; i < values.length; i++) {
      if (values[i] && values[i].id === String(sourceId)) { source = values[i]; break }
    }
    if (!source) { eventCreated(false, "Choose a calendar"); return }
    var built = Calendar.createEvent(fields, Date.now())
    if (!built.ok) { eventCreated(false, built.error); return }
    eventSource = source
    eventDraft = built
    creatingEvent = true
    if (source.kind === "google") createGoogleEvent()
    else {
      eventPasswordLookup.command = ["secret-tool", "lookup"]
        .concat(Sources.keyringAttributes(source.id))
      eventPasswordLookup.running = true
    }
  }

  function finishEvent(ok, error) {
    eventDeadline.stop()
    creatingEvent = false
    eventSource = null
    eventDraft = null
    eventRequest = null
    eventCreated(ok, String(error || ""))
    if (ok && rangeStart && rangeEnd) refresh(rangeStart, rangeEnd)
  }

  function createGoogleEvent() {
    service.withGoogleAccessToken(eventSource.accountId, function(token, error) {
      if (!token) { root.finishEvent(false, error); return }
      var request = new XMLHttpRequest()
      root.eventRequest = request
      request.open("POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events")
      request.setRequestHeader("Authorization", "Bearer " + token)
      request.setRequestHeader("Content-Type", "application/json")
      request.onreadystatechange = function() {
        if (request.readyState !== XMLHttpRequest.DONE) return
        eventDeadline.stop()
        root.eventRequest = null
        if (request.status < 200 || request.status >= 300) {
          root.finishEvent(false,
            Calendar.googleResponseError(request.status, request.responseText))
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
    if (refreshAccountId !== accountId) return
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
    if (refreshAccountId !== accountId) { processNext(); return }
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
      if (refreshAccountId === accountId) events = events.filter(function(event) {
        return allowed[String(event && event.sourceId || "")] === true
      })
      if (rangeStart && rangeEnd && refreshAccountId === accountId)
        eventCache.put(refreshAccountId, rangeStart, rangeEnd, events)
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
      request.open("GET", Calendar.googleEventsUrl(root.rangeStart, root.rangeEnd))
      request.setRequestHeader("Authorization", "Bearer " + token)
      request.onreadystatechange = function() {
        if (request.readyState !== XMLHttpRequest.DONE) return
        googleDeadline.stop()
        root.googleRequest = null
        if (request.status < 200 || request.status >= 300) {
          var reason = Calendar.googleResponseError(request.status, request.responseText)
          root.failSource(reason, Calendar.isGoogleCalendarApiDisabledError(reason)
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
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { root.handlePassword(line) }
    }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(_exitCode) { if (!root.lookupHandled) root.handlePassword("") }
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

  Timer {
    id: googleDeadline
    interval: 60000
    onTriggered: {
      if (root.googleRequest) root.googleRequest.abort()
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
      if (root.eventRequest) root.eventRequest.abort()
    }
  }
}
