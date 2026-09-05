import QtQuick
import qs.Commons
import qs.Ui
import "../message/Direction.js" as Direction

// Where mailboxes are managed.
//
// Adding one used to drop the user on the first-run walkthrough, which by then
// had nothing left to ask: the client was connected and an account was already
// signed in, so the page showed a finished setup for the *other* mailbox and
// there was no way forward. Adding a mailbox belongs here, next to the ones
// that already exist, and signing it in happens on its own row rather than by
// sending the window somewhere else.
Column {
  id: root

  required property var service
  required property var calendarController
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color urgentColor
  required property string panelFontFamily

  signal clientSetupRequested()
  signal addRequested()
  signal editRequested(int index)

  readonly property var accounts: service ? service.accountSummaries : []
  // A separate list on purpose: accountSummaries carries live mailbox state and
  // is replaced on a poll, which would rebuild the field being typed in.
  readonly property var signatureAccounts: service
    && Array.isArray(service.accountSignatures) ? service.accountSignatures : []
  property string selectedSignatureAccountId: ""

  // The page's sections and where each begins, for the rail beside it. Read
  // off the headings themselves, so a section that grows moves the ones
  // below it in the rail's map as well as on screen. The calendars section
  // is a component with its own heading, so its top stands in.
  readonly property var sections: [
    { key: "bar", title: "Bar", y: barHeading.y },
    { key: "reading", title: "Reading", y: readingHeading.y },
    { key: "notifications", title: "Notifications", y: notificationsHeading.y },
    { key: "writing", title: "Writing", y: writingHeading.y },
    { key: "agent", title: "Agent", y: agentHeading.y },
    { key: "mailboxes", title: "Mailboxes", y: mailboxesHeading.y },
    { key: "calendars", title: "Calendars", y: calendarsSection.y },
    { key: "oauth", title: "Google OAuth client", y: oauthHeading.y }
  ]
  readonly property var auth: service ? service.auth : null

  function saveAgentCommand() {
    if (!root.service) return
    var next = String(agentEdit.text || "").trim()
    if (next !== root.service.agentCommand) root.service.setAgentCommand(next)
  }

  function signatureAccount(id) {
    for (var i = 0; i < signatureAccounts.length; i++)
      if (String(signatureAccounts[i].id || "") === String(id || ""))
        return signatureAccounts[i]
    return null
  }

  function signatureOptions() {
    var out = []
    for (var i = 0; i < signatureAccounts.length; i++)
      out.push({ value: signatureAccounts[i].id, label: signatureAccounts[i].email })
    return out
  }

  property string selectedNameAccountId: ""

  function nameOptions() {
    var out = []
    for (var i = 0; i < signatureAccounts.length; i++)
      out.push({ value: signatureAccounts[i].id, label: signatureAccounts[i].email })
    return out
  }

  function saveName() {
    if (service && selectedNameAccountId !== "")
      service.setAccountLabel(selectedNameAccountId, nameEdit.text)
  }

  function selectNameAccount(id) {
    var next = signatureAccount(id)
    if (!next || String(next.id || "") === selectedNameAccountId) return
    saveName()
    selectedNameAccountId = String(next.id || "")
    nameEdit.text = String(next.label || "")
  }

  function ensureNameAccount() {
    if (signatureAccounts.length === 0) {
      selectedNameAccountId = ""
      nameEdit.text = ""
      return
    }
    if (signatureAccount(selectedNameAccountId)) return
    var activeId = service ? String(service.activeAccountId || "") : ""
    var next = signatureAccount(activeId) || signatureAccounts[0]
    selectedNameAccountId = String(next.id || "")
    nameEdit.text = String(next.label || "")
  }

  function saveSignature() {
    if (service && selectedSignatureAccountId !== "")
      service.setAccountSignature(selectedSignatureAccountId, signatureEdit.text)
  }

  function selectSignatureAccount(id) {
    var next = signatureAccount(id)
    if (!next || String(next.id || "") === selectedSignatureAccountId) return
    saveSignature()
    selectedSignatureAccountId = String(next.id || "")
    signatureEdit.text = String(next.signature || "")
  }

  function ensureSignatureAccount() {
    if (signatureAccounts.length === 0) {
      selectedSignatureAccountId = ""
      signatureEdit.text = ""
      return
    }
    if (signatureAccount(selectedSignatureAccountId)) return
    var activeId = service ? String(service.activeAccountId || "") : ""
    var next = signatureAccount(activeId) || signatureAccounts[0]
    selectedSignatureAccountId = String(next.id || "")
    signatureEdit.text = String(next.signature || "")
  }

  onSignatureAccountsChanged: {
    ensureSignatureAccount()
    ensureNameAccount()
  }
  Component.onCompleted: {
    ensureSignatureAccount()
    ensureNameAccount()
  }

  spacing: Style.space(16)

  Text {
    text: "Settings"
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.heading
    font.bold: true
  }

  // ------------------------------------------------------------------- bar

  Text {
    id: barHeading
    text: "BAR"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(barIconText.implicitHeight, barIconSwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: barIconText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: barIconSwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Show the icon in the bar"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        textFormat: Text.PlainText
      }

      // Says what turning it off costs, and what it does not: mail is still
      // checked and still notifies. The keybinding is the part worth naming,
      // because without one the window is only reachable from a terminal —
      // which is true, and is why this does not claim there is no way back.
      Text {
        width: parent.width
        text: "Mail is still checked and still notifies; only the envelope goes. "
          + "With it off the window opens from a keybinding or a terminal and "
          + "nowhere else, so bind a key before turning this off:"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }

      Text {
        width: parent.width
        text: "o.bind(\"SUPER + SHIFT + G\", \"Omamail\", "
          + "\"omarchy shell shell toggle omamail '\{}'\")"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
        textFormat: Text.PlainText
      }
    }

    ToggleSwitch {
      id: barIconSwitch
      objectName: "showBarIconSwitch"
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !root.service || root.service.showBarIcon !== false
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service) root.service.setShowBarIcon(!root.service.showBarIcon)
    }
  }

  // --------------------------------------------------------------- reading

  Text {
    id: readingHeading
    text: "READING"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(imagesText.implicitHeight, imagesSwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: imagesText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: imagesSwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Always show remote images"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        // The cost, in the words of what it actually tells whom. Off, the
        // reader asks about each message and the answer covers that one.
        text: "Loading an image tells its host that this address opened the "
          + "message, and when"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    ToggleSwitch {
      id: imagesSwitch
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !!root.service && root.service.alwaysShowImages
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service) root.service.setAlwaysShowImages(!root.service.alwaysShowImages)
    }
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(heavyText.implicitHeight, heavySwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: heavyText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: heavySwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Always render heavy messages"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        text: "Renders without falling back first; layout can stall the shell while it works"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    ToggleSwitch {
      id: heavySwitch
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !!root.service && root.service.alwaysRenderHeavyMessages
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service)
        root.service.setAlwaysRenderHeavyMessages(!root.service.alwaysRenderHeavyMessages)
    }
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(directionText.implicitHeight, directionTrack.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: directionText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: directionTrack.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Message direction"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        // Says what Auto does rather than only naming it: a reader whose mail
        // is already laid out correctly has no way to tell whether that is the
        // setting working or the setting being unnecessary.
        text: "Auto reads it from the message's own text. The interface is unaffected."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    // Three names for one setting, sharing a track and the seams between them,
    // the way the reader's own view modes do.
    Rectangle {
      id: directionTrack
      objectName: "contentDirectionTrack"
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      width: directionSegments.implicitWidth
      height: directionSegments.implicitHeight
      radius: Style.cornerRadius
      color: "transparent"
      border.width: 1
      border.color: Style.normalBorderFor(root.textColor, root.accentColor)

      Row {
        id: directionSegments
        spacing: 0

        // The labels are the stored values: the shell hands a plugin the words
        // the schema lists rather than a key behind them, so spelling them
        // anywhere but Direction.js would be a second place to keep them right.
        DirectionButton {
          text: Direction.AUTO; mode: Direction.AUTO; firstSegment: true
        }
        DirectionButton { text: Direction.LEFT_TO_RIGHT; mode: Direction.LEFT_TO_RIGHT }
        DirectionButton { text: Direction.RIGHT_TO_LEFT; mode: Direction.RIGHT_TO_LEFT }
      }
    }
  }

  // -------------------------------------------------------- notifications

  Text {
    id: notificationsHeading
    text: "NOTIFICATIONS"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(notifyText.implicitHeight, notifySwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: notifyText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: notifySwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "New mail notifications"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        text: "Send a desktop notification when new mail arrives in your inbox"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    ToggleSwitch {
      id: notifySwitch
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !!root.service && root.service.notifyNewMail
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service)
        root.service.setNotifyNewMail(!root.service.notifyNewMail)
    }
  }

  // --------------------------------------------------------------- writing

  Text {
    id: writingHeading
    text: "WRITING"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(undoText.implicitHeight, undoSeconds.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: undoText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: undoSeconds.left
      anchors.rightMargin: Style.space(16)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Undo send window"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        text: "Omamail waits before delivery. Press Alt+Z or select Undo to cancel. Set 0 to send now."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    NumberField {
      id: undoSeconds
      anchors.right: parent.right
      anchors.rightMargin: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      label: "Seconds"
      from: 0
      to: 60
      stepSize: 1
      value: root.service ? root.service.undoSendSeconds : 10
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      fontSize: Style.font.bodySmall
      onModified: function(next) {
        if (root.service) root.service.setUndoSendSeconds(next)
      }
    }
  }

  // A signature signs a mailbox, not a window. Only the selected mailbox is
  // expanded here: a long account list should not turn Writing into a stack of
  // editors, and switching is an explicit answer to which identity is edited.
  Column {
    objectName: "settings-signature-section"
    width: parent.width
    spacing: Style.space(2)
    // The heading and the note below belong to the fields. With no mailbox
    // signed in there are none, and first run would otherwise show an
    // explanation with nothing between it and the heading.
    visible: root.signatureAccounts.length > 0

    Text {
      text: "Signature"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      bottomPadding: Style.space(4)
    }

    Dropdown {
      objectName: "settings-signature-account-picker"
      visible: root.signatureAccounts.length > 1
      width: parent.width
      showLabel: false
      value: root.selectedSignatureAccountId
      options: root.signatureOptions()
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      onChanged: function(next) { root.selectSignatureAccount(next) }
    }

    Rectangle {
      width: parent.width
      implicitHeight: Math.max(signatureEdit.implicitHeight, Style.space(56))
        + Style.space(20)
      radius: Style.cornerRadius
      color: Style.normalFillFor(root.textColor, root.accentColor)

      // The padding is part of the field visually, so it is part of its click
      // target too. Kept behind the editor so clicks on text still place the
      // cursor normally.
      MouseArea {
        anchors.fill: parent
        onClicked: signatureEdit.forceActiveFocus()
      }

      TextEdit {
        id: signatureEdit
        objectName: "settings-signature-editor"
        anchors.fill: parent
        anchors.margins: Style.space(10)
        activeFocusOnTab: true
        selectByMouse: true
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.PlainText
        color: root.textColor
        selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
        selectedTextColor: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall

        // The editor survives account-list updates and routine mailbox polls.
        // Its text changes only when the selected identity changes.
        onActiveFocusChanged: if (!activeFocus) root.saveSignature()
      }

      Text {
        anchors.left: signatureEdit.left
        anchors.top: signatureEdit.top
        enabled: false
        visible: signatureEdit.text === ""
        text: "No signature"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }

    Text {
      width: parent.width
      text: "Sits under a new message, and above the quoted text in a reply. "
        + "Sent as written — no separator line is added in front of it."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Component.onDestruction: root.saveSignature()
  }

  // ----------------------------------------------------------------- agent

  Text {
    id: agentHeading
    text: "AGENT"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  // The default agent: a command line, and nothing else. With it empty there
  // is no agent button anywhere; docs/AGENT.md says what the command is
  // handed and what it is expected to do.
  Column {
    objectName: "settings-agent-section"
    width: parent.width
    spacing: Style.space(6)

    Text {
      width: parent.width
      text: "Default agent command"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    TextField {
      id: agentEdit
      objectName: "settings-agent-editor"
      width: parent.width
      foreground: root.textColor
      accent: root.accentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "claude -p"
      text: root.service ? root.service.agentCommand : ""
      onActiveFocusChanged: if (!activeFocus) root.saveAgentCommand()
      onAccepted: root.saveAgentCommand()
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: "A command that reads a prompt on stdin and answers on stdout — "
        + "claude -p, codex exec, a script of your own. With one set, every "
        + "message gains an agent button and Alt+G, and the agent runs in the "
        + "background as a systemd user unit, reading and writing mail through "
        + "himalaya. Leave it empty for no agent."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // ------------------------------------------------------------- mailboxes

  Text {
    id: mailboxesHeading
    text: "MAILBOXES"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  // What to call a mailbox, which the list below draws and the switcher and
  // every merged row draw too. Two of these can differ only in their domain
  // and elide to the same handful of characters, so a name is the one thing
  // that tells them apart at a glance.
  //
  // A picker and one field rather than a field on each row: the rows carry
  // live mailbox state and are rebuilt whenever a poll changes an unread
  // count, which would take the field apart while it was being typed into.
  // This is the same reason the signature editor is shaped this way.
  Column {
    width: parent.width
    spacing: Style.space(6)
    visible: root.signatureAccounts.length > 0

    // Two questions, one under the other, each with its own label: which
    // mailbox, and what to call it. They were one block under a single "Name"
    // heading, which read as though the address in the picker *was* the name
    // and left nothing that looked like somewhere to type.
    Text {
      width: parent.width
      visible: root.signatureAccounts.length > 1
      text: "Mailbox"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Dropdown {
      objectName: "settings-name-account-picker"
      visible: root.signatureAccounts.length > 1
      width: parent.width
      showLabel: false
      value: root.selectedNameAccountId
      options: root.nameOptions()
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      onChanged: function(next) { root.selectNameAccount(next) }
    }

    Item {
      width: parent.width
      implicitHeight: Style.space(4)
      visible: root.signatureAccounts.length > 1
    }

    Text {
      width: parent.width
      text: "Name"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    // The kit's own single-line input, which is what every other field on
    // this page is: it carries the focus ring, the selection colours and a
    // real placeholder, and it takes a click without one being arranged for
    // it. A hand-built Rectangle around a bare TextInput drew the same box
    // and could not be typed into.
    TextField {
      id: nameEdit
      objectName: "settings-name-editor"
      width: parent.width
      foreground: root.textColor
      accent: root.accentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall

      // Saved on the way out rather than on every keystroke, so the account
      // file is written once per edit and the field is never rebuilt from
      // under the cursor.
      onActiveFocusChanged: if (!activeFocus) root.saveName()
      onAccepted: root.saveName()
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: "What this mailbox is called in Omamail — in the switcher, in this "
        + "list, and beside every message in a combined view. Leave it empty "
        + "to use the address. It is not sent to anyone."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  Column {
    width: parent.width
    spacing: Style.space(2)

    Repeater {
      model: root.accounts

      Rectangle {
        id: row
        required property var modelData
        required property int index

        width: parent.width
        implicitHeight: Math.max(rowText.implicitHeight, rowActions.implicitHeight)
          + Style.space(16)
        radius: Style.cornerRadius
        // Which mailbox the window is showing is not a fact about this page.
        // Nothing here acts on it — `Edit...` acts on its own row, and the
        // signature section names the mailbox it signs — and the row answers
        // no click, so marking it borrowed the switcher's "you are here, click
        // another" fill for a row that switches nothing.
        color: Style.normalFillFor(root.textColor, root.accentColor)

        Column {
          id: rowText
          anchors.left: parent.left
          anchors.leftMargin: Style.space(12)
          anchors.right: rowActions.left
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            // The name if one was given, so this list and the switcher agree
            // about what each mailbox is called. The address is on the line
            // below either way, which keeps the row identifiable.
            text: {
              var named = row.modelData.name !== undefined
                && String(row.modelData.name) !== ""
              if (named) return String(row.modelData.name)
              return row.modelData.email !== "" ? row.modelData.email : "New mailbox"
            }
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideMiddle
          }

          Text {
            width: parent.width
            // The address and whatever a server had to say are both in here,
            // and Qt's default would run the rich text engine over either.
            textFormat: Text.PlainText
            text: {
              if (row.modelData.error !== undefined && row.modelData.error !== "")
                return row.modelData.error
              if (!row.modelData.signedIn) return "Signed out"
              var count = row.modelData.unread
              var unread = count === 0 ? "No unread mail"
                : (count === 1 ? "1 unread message" : count + " unread messages")
              // A named row has put its name on the line above, so the address
              // belongs here — otherwise nothing on the row says which mailbox
              // it is.
              var named = row.modelData.name !== undefined
                && String(row.modelData.name) !== ""
              return named ? String(row.modelData.email) + " · " + unread : unread
            }
            color: row.modelData.error !== undefined && row.modelData.error !== ""
              ? root.urgentColor : root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        Row {
          id: rowActions
          anchors.right: parent.right
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(6)

          IconTextButton {
            text: "Edit..."
            foreground: root.textColor
            fontFamily: root.panelFontFamily
            tooltipText: "Edit this mailbox"
            onClicked: root.editRequested(row.index)
          }
        }
      }
    }
  }

  IconTextButton {
    iconName: "plus"
    text: "Add a mailbox..."
    foreground: root.textColor
    fontFamily: root.panelFontFamily
    tooltipText: "Add another mail account"
    onClicked: root.addRequested()
  }

  PanelSeparator {
    width: parent.width
    foreground: root.textColor
  }

  CalendarSettings {
    id: calendarsSection
    width: parent.width
    service: root.service
    controller: root.calendarController
    textColor: root.textColor
    dimColor: root.dimColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    panelFontFamily: root.panelFontFamily
  }

  PanelSeparator {
    width: parent.width
    foreground: root.textColor
  }

  // ---------------------------------------------------------- oauth client

  Text {
    id: oauthHeading
    text: "GOOGLE OAUTH CLIENT"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Item {
    width: parent.width
    implicitHeight: Math.max(clientText.implicitHeight, clientButton.implicitHeight)

    Column {
      id: clientText
      anchors.left: parent.left
      anchors.right: clientButton.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: root.auth && root.auth.credentialsPresent
          ? String(root.auth.clientDescription || "Google OAuth client") : "No client yet"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideMiddle
      }

      Text {
        width: parent.width
        // Every mailbox signs in through this one client, which is why adding
        // an account never asks for another.
        text: "Shared by every mailbox above"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    IconTextButton {
      id: clientButton
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: root.auth && root.auth.credentialsPresent ? "Change..." : "Set up..."
      foreground: root.dimColor
      fontFamily: root.panelFontFamily
      onClicked: root.clientSetupRequested()
    }
  }

  // One of the three ways a message's direction is arrived at.
  component DirectionButton: Button {
    required property string mode
    property bool firstSegment: false
    selected: !!root.service && root.service.contentDirection === mode
    bordered: false
    foreground: selected ? root.textColor : root.dimColor
    accent: root.accentColor
    fontFamily: root.panelFontFamily
    fontSize: Style.font.caption
    horizontalPadding: Style.space(7)
    verticalPadding: Style.space(3)
    onClicked: if (root.service) root.service.setContentDirection(mode)

    Rectangle {
      visible: !parent.firstSegment
      width: 1
      height: parent.height
      color: directionTrack.border.color
    }
  }
}
