import QtQuick
import QtQuick.Controls
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../message/Message.js" as Mail
import "../compose/Recipients.js" as Recipients

// Composing takes over the whole content area of the one window rather than
// opening a second one: Omarchy's panel mechanism would give an extra window
// its own region, which is not what a reply is. Two mail accounts would
// justify two windows; a reply does not.
//
// Compose, reply, reply-all and forward are the same form with different
// starting values, so `begin()` fills the fields and everything after that is
// one code path.
Item {
  id: root

  required property var service
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color dimColor
  required property color dimmerColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  readonly property int formInset: Style.space(18)
  readonly property int formLabelWidth: Style.space(52)
  readonly property int formLabelGap: Style.space(10)
  readonly property bool deliveryLocked: !!root.service
    && (root.service.sendPending || root.service.sending)

  property bool opened: false
  property bool parkedForSend: false
  property string mode: "new"
  property string threadId: ""
  property string inReplyTo: ""
  property bool ccVisible: false
  property bool bccVisible: false
  property string fromEmail: ""
  property var replyRecipients: []
  property bool fromWasChosen: false
  property var toSuggestions: []
  property var ccSuggestions: []
  property var originalAttachments: []
  property var forwardedAttachments: []
  property bool forwardAttachmentsLoading: false
  property string forwardAttachmentError: ""
  property int forwardLoadSerial: 0

  readonly property var contactBook: root.service
    && Array.isArray(root.service.recipientContacts)
    ? root.service.recipientContacts : []

  readonly property var fromAliases: {
    if (!root.service || !Array.isArray(root.service.sendAsAliases)) return []
    return root.service.sendAsAliases
  }

  readonly property string title: {
    if (mode === "reply") return "Reply"
    if (mode === "replyAll") return "Reply all"
    if (mode === "forward") return "Forward"
    return "New message"
  }

  function reset() {
    forwardLoadSerial++
    fromMenu.close()
    toField.text = ""
    ccField.text = ""
    bccField.text = ""
    subjectField.text = ""
    bodyEdit.text = ""
    mode = "new"
    threadId = ""
    inReplyTo = ""
    ccVisible = false
    bccVisible = false
    fromEmail = ""
    replyRecipients = []
    fromWasChosen = false
    toSuggestions = []
    ccSuggestions = []
    originalAttachments = []
    forwardedAttachments = []
    forwardAttachmentsLoading = false
    forwardAttachmentError = ""
    parkedForSend = false
  }

  function selectPreferredFrom() {
    var choice = root.service ? root.service.preferredSendAs(replyRecipients) : null
    fromEmail = choice ? String(choice.email || "") : ""
  }

  function chooseFrom(email) {
    fromEmail = String(email || "")
    fromWasChosen = true
    fromMenu.close()
  }

  function placeFromMenu() {
    if (!fromMenu.visible) return
    var global = fromButton.mapToGlobal(0, 0)
    var at = root.mapFromGlobal(global.x, global.y)
    var tall = fromMenu.height > 0 ? fromMenu.height : fromMenu.implicitHeight
    var x = Math.max(0, Math.min(at.x, root.width - fromMenu.width))
    var y = at.y + fromButton.height
    if (y + tall > root.height) y = at.y - tall
    if (y + tall > root.height) y = root.height - tall
    if (y < 0) y = 0
    fromMenu.x = x
    fromMenu.y = y
  }

  // Everyone on the original except this mailbox: replying to yourself is
  // never what reply-all was for.
  function otherRecipients(summary) {
    if (!summary) return ""
    var mine = String(root.service ? root.service.accountEmail : "").toLowerCase()
    var list = Array.isArray(summary.to) ? summary.to : []
    var kept = []
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].email || "").toLowerCase() === mine) continue
      kept.push(list[i].email)
    }
    return kept.join(", ")
  }

  function updateRecipientSuggestions() {
    toSuggestions = toField.activeFocus
      ? Recipients.suggest(contactBook, toField.text, 5) : []
    ccSuggestions = ccField.activeFocus
      ? Recipients.suggest(contactBook, ccField.text, 5) : []
  }

  function acceptTo(contact) {
    toField.text = Recipients.accept(toField.text, contact)
    toSuggestions = []
    toField.forceActiveFocus()
  }

  function acceptCc(contact) {
    ccField.text = Recipients.accept(ccField.text, contact)
    ccSuggestions = []
    ccField.forceActiveFocus()
  }

  function loadForwardAttachments() {
    if (!service || originalAttachments.length === 0) return
    var serial = ++forwardLoadSerial
    forwardAttachmentsLoading = true
    forwardAttachmentError = ""
    forwardedAttachments = []
    service.loadAttachments(service.selectedId, originalAttachments,
      function(loaded, error) {
        if (serial !== root.forwardLoadSerial || !root.opened || root.mode !== "forward") return
        root.forwardAttachmentsLoading = false
        root.forwardAttachmentError = String(error || "")
        root.forwardedAttachments = error ? [] : loaded
      })
  }

  function begin(nextMode, summary, bodyText, attachments) {
    reset()
    mode = String(nextMode || "new")
    opened = true

    if (summary && mode !== "new") {
      var replyTo = summary.replyTo && summary.replyTo.email
        ? summary.replyTo.email : summary.from.email
      threadId = summary.threadId
      inReplyTo = summary.messageId
      // Cc as well as To: an alias is just as often the address a thread
      // copied you on as the one it was sent to, and answering from the
      // account's default instead is how a thread ends up split in two.
      if (mode === "reply" || mode === "replyAll") {
        replyRecipients = (Array.isArray(summary.to) ? summary.to : [])
          .concat(Array.isArray(summary.cc) ? summary.cc : [])
      }

      if (mode === "forward") {
        subjectField.text = "Fwd: " + summary.subject
        originalAttachments = Array.isArray(attachments) ? attachments.slice() : []
        if (originalAttachments.length > 0) loadForwardAttachments()
      } else {
        toField.text = replyTo
        subjectField.text = Mail.replySubject(summary.subject)
        if (mode === "replyAll") {
          ccField.text = otherRecipients(summary)
          ccVisible = ccField.text !== ""
        }
      }
      bodyEdit.text = "\n\n" + Mail.quoteBody(summary, String(bodyText || ""))
    }

    selectPreferredFrom()
    if (root.service) root.service.refreshRecipientContacts()

    // Focus is not placed here. Opening this changes the window's key context,
    // and the context is what moves the keyboard — one mechanism, so the two
    // cannot disagree about where the typing goes.
  }

  // A mailto: link is a new message with the fields already named. Reply and
  // forward stay on `begin`; they fill from a message, not from a URL.
  function beginDraft(draft) {
    begin("new", null, "", [])
    var values = draft || ({})
    toField.text = String(values.to || "")
    ccField.text = String(values.cc || "")
    ccVisible = ccField.text !== ""
    bccField.text = String(values.bcc || "")
    bccVisible = bccField.text !== ""
    subjectField.text = String(values.subject || "")
    bodyEdit.text = String(values.body || "")
  }

  // Where the keyboard goes when composing becomes the context. A reply starts
  // in the body above the quote; a new message starts at the address.
  function takeFocus() {
    if (mode === "reply" || mode === "replyAll") {
      bodyEdit.forceActiveFocus()
      bodyEdit.cursorPosition = 0
    } else if (toField.text === "") {
      toField.forceActiveFocus()
    } else if (subjectField.text === "") {
      subjectField.forceActiveFocus()
    } else {
      bodyEdit.forceActiveFocus()
    }
  }

  // Every way out of a draft: this view's own Back, Discard, the window's
  // Escape, and the send that succeeded. The window is told because only the
  // window knows where the draft was raised from.
  signal closed()
  signal sendQueued()

  function finish() {
    reset()
    opened = false
    closed()
  }

  function parkForSend() {
    opened = false
    parkedForSend = true
    sendQueued()
  }

  function resumePendingSend() {
    if (!parkedForSend) return false
    parkedForSend = false
    opened = true
    return true
  }

  function cancelOrFinish() {
    if (root.service && root.service.sendPending) root.service.undoSend()
    else finish()
  }

  function submit() {
    if (!service) return
    if (forwardAttachmentsLoading || forwardAttachmentError !== "") return
    var accepted = service.send(({
      from: root.fromEmail,
      to: toField.text,
      cc: ccField.text,
      bcc: bccField.text,
      subject: subjectField.text,
      body: bodyEdit.text,
      attachments: root.mode === "forward" ? root.forwardedAttachments : [],
      // A forward starts a new conversation; a reply must stay in the old one.
      threadId: root.mode === "forward" ? "" : root.threadId,
      inReplyTo: root.mode === "forward" ? "" : root.inReplyTo
    }))
    if (accepted === true || service.sendPending || service.sending) parkForSend()
  }

  anchors.fill: parent
  // Only while it is actually in use. A component that declares `focus: true`
  // owns the window's focus even when invisible — Qt does not exclude hidden
  // items — and an owner that accepts keys is a sink. This swallowed every
  // Escape in the window, which is why Esc looked intermittent: whether it
  // worked depended on where the user had last clicked.
  focus: root.opened

  onFromAliasesChanged: {
    if (opened && !fromWasChosen) selectPreferredFrom()
  }
  onContactBookChanged: updateRecipientSuggestions()

  // ----------------------------------------------------------- header
  //
  // One compact title band. Back is the exit path and the title names the
  // draft; splitting them into two stacked bands gave one short decision the
  // hierarchy of a whole settings page.
  Item {
    id: head
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    height: Style.space(44)

    BackBar {
      id: backBar
      anchors.left: parent.left
      anchors.leftMargin: Style.space(14)
      anchors.verticalCenter: parent.verticalCenter
      textColor: root.textColor
      dimColor: root.dimColor
      panelFontFamily: root.panelFontFamily
      onActivated: root.cancelOrFinish()
    }

    Row {
      id: titleRow
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(10)

      PanelSectionHeader {
        anchors.verticalCenter: parent.verticalCenter
        text: root.title
        foreground: root.textColor
        fontFamily: root.panelFontFamily
      }
    }

    PanelSeparator {
      anchors.bottom: parent.bottom
      width: parent.width
      foreground: root.textColor
    }
  }

  // ----------------------------------------------------------- fields
  //
  // A label column wide enough for the longest of To / Cc / Subject keeps
  // the three inputs aligned without a grid.

  Column {
    id: fields
    objectName: "compose-fields"
    anchors.top: head.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    // Suggestions extend below this column into the message body. Raising only
    // the row cannot cross the sibling boundary, so the body painted over the
    // popup even though the popup itself had a high z value.
    z: 10

    Item {
      width: parent.width
      implicitHeight: fromButton.implicitHeight + Style.space(14)

      Text {
        id: fromLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "From"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      // Sized to the address rather than to the row: a full-width trigger puts
      // the chevron a screen away from the name it belongs to. The extra width
      // is the room the chevron is drawn into, over the button's own trailing
      // padding, so the two read as one control.
      Button {
        id: fromButton
        readonly property real trailing: root.fromAliases.length > 1
          ? Style.font.iconSmall + Style.spacing.controlGap : 0

        anchors.left: fromLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.verticalCenter: parent.verticalCenter
        width: Math.min(implicitWidth + trailing,
          parent.width - fromLabel.width - Style.space(46))
        text: root.fromEmail
        foreground: root.textColor
        accent: root.accentColor
        background: Style.normalFillFor(root.textColor, root.accentColor)
        bordered: true
        fontFamily: root.panelFontFamily
        fontSize: Style.font.bodySmall
        verticalPadding: Style.spacing.inputPaddingY
        leftAlign: true
        selected: fromMenu.opened
        enabled: root.fromAliases.length > 1 && !root.deliveryLocked
        onClicked: fromMenu.opened ? fromMenu.close() : fromMenu.open()

        // The kit's own chevron is a font glyph, which at this size renders
        // thinner than every other mark in the window. This is the app's drawn
        // set, at the size the rest of the icons use.
        ActionIcon {
          anchors.right: parent.right
          anchors.rightMargin: fromButton.horizontalPadding
          anchors.verticalCenter: parent.verticalCenter
          visible: root.fromAliases.length > 1
          name: "chevronDown"
          iconSize: Style.font.iconSmall
          color: root.dimColor
        }
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      width: parent.width
      z: root.toSuggestions.length > 0 ? 100 : 0
      // The field plus the same breathing room it carries inside itself, so
      // its border is not crowded against the rules above and below. Derived
      // rather than a fixed height: the field grows with the theme's font
      // scale, and a fixed row would scale that growth a second time.
      implicitHeight: toField.implicitHeight + Style.space(14)

      Text {
        id: toLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "To"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Button {
        id: ccToggle
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        text: "Cc"
        foreground: root.ccVisible ? root.textColor : root.dimColor
        bordered: false
        fontSize: Style.font.caption
        enabled: !root.deliveryLocked
        onClicked: root.ccVisible = !root.ccVisible
      }

      TextField {
        id: toField
        objectName: "compose-to-field"
        anchors.left: toLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: ccToggle.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "recipient@example.com"
        enabled: !root.deliveryLocked
        onTextChanged: root.updateRecipientSuggestions()
        onActiveFocusChanged: root.updateRecipientSuggestions()
        Keys.onPressed: function(event) {
          if (root.toSuggestions.length === 0) return
          if (event.key === Qt.Key_Down) {
            toSuggestionsPopup.moveSelection(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            toSuggestionsPopup.moveSelection(-1)
            event.accepted = true
          }
        }
        onAccepted: {
          if (root.toSuggestions.length > 0) toSuggestionsPopup.acceptSelection()
          else subjectField.forceActiveFocus()
        }
      }

      RecipientSuggestions {
        id: toSuggestionsPopup
        objectName: "compose-to-suggestions"
        x: toField.x
        y: parent.height - Style.space(2)
        width: toField.width
        z: 60
        contacts: root.toSuggestions
        textColor: root.textColor
        dimColor: root.dimColor
        accentColor: root.accentColor
        popupBackgroundColor: root.popupBackgroundColor
        popupBorderColor: root.popupBorderColor
        panelFontFamily: root.panelFontFamily
        onChosen: function(contact) { root.acceptTo(contact) }
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      visible: root.ccVisible
      width: parent.width
      z: root.ccSuggestions.length > 0 ? 100 : 0
      // The field plus the same breathing room it carries inside itself, so
      // its border is not crowded against the rules above and below. Derived
      // rather than a fixed height: the field grows with the theme's font
      // scale, and a fixed row would scale that growth a second time.
      implicitHeight: ccField.implicitHeight + Style.space(14)

      Text {
        id: ccLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Cc"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: ccField
        objectName: "compose-cc-field"
        anchors.left: ccLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        enabled: !root.deliveryLocked
        onTextChanged: root.updateRecipientSuggestions()
        onActiveFocusChanged: root.updateRecipientSuggestions()
        Keys.onPressed: function(event) {
          if (root.ccSuggestions.length === 0) return
          if (event.key === Qt.Key_Down) {
            ccSuggestionsPopup.moveSelection(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            ccSuggestionsPopup.moveSelection(-1)
            event.accepted = true
          }
        }
        onAccepted: {
          if (root.ccSuggestions.length > 0) ccSuggestionsPopup.acceptSelection()
          else subjectField.forceActiveFocus()
        }
      }

      RecipientSuggestions {
        id: ccSuggestionsPopup
        x: ccField.x
        y: parent.height - Style.space(2)
        width: ccField.width
        z: 60
        contacts: root.ccSuggestions
        textColor: root.textColor
        dimColor: root.dimColor
        accentColor: root.accentColor
        popupBackgroundColor: root.popupBackgroundColor
        popupBorderColor: root.popupBorderColor
        panelFontFamily: root.panelFontFamily
        onChosen: function(contact) { root.acceptCc(contact) }
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      visible: root.bccVisible
      width: parent.width
      implicitHeight: bccField.implicitHeight + Style.space(14)

      Text {
        id: bccLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Bcc"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: bccField
        objectName: "compose-bcc-field"
        anchors.left: bccLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        enabled: !root.deliveryLocked
        onAccepted: subjectField.forceActiveFocus()
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      width: parent.width
      // The field plus the same breathing room it carries inside itself, so
      // its border is not crowded against the rules above and below. Derived
      // rather than a fixed height: the field grows with the theme's font
      // scale, and a fixed row would scale that growth a second time.
      implicitHeight: subjectField.implicitHeight + Style.space(14)

      Text {
        id: subjectLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Subject"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: subjectField
        objectName: "compose-subject-field"
        anchors.left: subjectLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Subject"
        enabled: !root.deliveryLocked
        KeyNavigation.tab: bodyEdit
        onAccepted: bodyEdit.forceActiveFocus()
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      visible: root.mode === "forward" && root.originalAttachments.length > 0
      width: parent.width
      implicitHeight: attachmentSummary.implicitHeight + Style.space(14)

      Text {
        id: attachmentLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.top: parent.top
        anchors.topMargin: Style.space(9)
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Files"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Column {
        id: attachmentSummary
        anchors.left: attachmentLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: retryAttachments.left
        anchors.rightMargin: Style.space(8)
        anchors.top: parent.top
        anchors.topMargin: Style.space(7)
        spacing: Style.space(3)

        Text {
          width: parent.width
          text: root.forwardAttachmentsLoading
            ? "Loading original attachments..."
            : (root.forwardAttachmentError !== ""
              ? root.forwardAttachmentError
              : Mail.formatCount(root.forwardedAttachments.length, "original attachment")
                + " will be forwarded")
          textFormat: Text.PlainText
          color: root.forwardAttachmentError !== "" ? root.accentColor : root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Repeater {
          model: root.originalAttachments
          Text {
            required property var modelData
            width: attachmentSummary.width
            textFormat: Text.PlainText
            text: String(modelData.filename || "attachment") + "  "
              + Mail.formatSize(modelData.size)
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideMiddle
          }
        }
      }

      Button {
        id: retryAttachments
        visible: root.forwardAttachmentError !== ""
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.top: parent.top
        anchors.topMargin: Style.space(6)
        text: "Retry"
        foreground: root.textColor
        bordered: false
        fontSize: Style.font.caption
        onClicked: root.loadForwardAttachments()
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }
  }

  QQC.Popup {
    id: fromMenu
    width: Math.min(Style.space(360), root.width - Style.space(36))
    implicitHeight: Math.min(fromRows.implicitHeight + Style.space(8), Style.space(260))
    padding: Style.space(4)
    modal: false
    focus: opened
    z: 50
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.placeFromMenu()
    onOpened: root.placeFromMenu()
    background: Rectangle {
      radius: Style.cornerRadius
      color: Qt.rgba(root.popupBackgroundColor.r, root.popupBackgroundColor.g,
        root.popupBackgroundColor.b, 1)
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: ListView {
      id: fromRows
      implicitHeight: contentHeight
      clip: true
      model: root.fromAliases

      delegate: Rectangle {
        id: fromRow
        required property var modelData

        width: fromMenu.width - fromMenu.leftPadding - fromMenu.rightPadding
        implicitHeight: Style.space(42)
        radius: Style.cornerRadius
        color: root.fromEmail.toLowerCase() === String(modelData.email || "").toLowerCase()
          ? Style.selectedFillFor(root.textColor, root.accentColor)
          : (fromHover.hovered
            ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

        Column {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(9)
          anchors.right: parent.right
          anchors.rightMargin: Style.space(9)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(1)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: String(fromRow.modelData.email || "")
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: root.fromEmail.toLowerCase()
              === String(fromRow.modelData.email || "").toLowerCase()
            elide: Text.ElideMiddle
          }

          Text {
            width: parent.width
            visible: text !== ""
            textFormat: Text.PlainText
            text: String(fromRow.modelData.displayName || "")
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        HoverHandler { id: fromHover }
        TapHandler { onTapped: root.chooseFrom(fromRow.modelData.email) }
      }
    }
  }

  // ------------------------------------------------------------- body
  //
  // The kit has no multi-line field, so this is a TextEdit on the plain
  // window ground; the rows above already carry the structure.
  Flickable {
    id: bodyFlick
    objectName: "compose-body"
    anchors.top: fields.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: actions.top
    anchors.leftMargin: Style.space(18)
    anchors.rightMargin: Style.space(18)
    anchors.topMargin: Style.space(12)
    contentWidth: width
    contentHeight: bodyEdit.height
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    TextEdit {
      id: bodyEdit
      objectName: "compose-body-editor"
      activeFocusOnTab: true
      width: bodyFlick.width
      // Tall enough to fill the visible area even when the draft is short.
      // A TextEdit sized to its text leaves the space below it belonging to
      // the Flickable, so clicking into the empty part of a mostly-empty
      // message does nothing at all.
      height: Math.max(implicitHeight, bodyFlick.height)
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      textFormat: TextEdit.PlainText
      color: root.textColor
      selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
      selectedTextColor: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      enabled: !root.deliveryLocked
    }
  }

  // ---------------------------------------------------------- actions

  Item {
    id: actions
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    height: Style.space(52)

    PanelSeparator {
      anchors.top: parent.top
      width: parent.width
      foreground: root.textColor
    }

    Row {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(18)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(10)

      IconTextButton {
        iconName: root.service && root.service.sendPending ? "undo" : "send"
        tooltipText: root.service && root.service.sendPending
          ? "Undo send · Ctrl+Z" : "Send · Ctrl+Enter"
        text: root.service && root.service.sendPending
          ? "Undo send (" + root.service.sendSecondsRemaining + "s)"
          : (root.service && root.service.sending ? "Sending" : "Send")
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        enabled: !!root.service && !root.service.sending
          && (root.service.sendPending || (!root.forwardAttachmentsLoading
            && root.forwardAttachmentError === ""))
        onClicked: {
          if (root.service.sendPending) root.service.undoSend()
          else root.submit()
        }
      }

      Button {
        text: "Discard"
        foreground: root.dimColor
        bordered: false
        fontSize: Style.font.bodySmall
        enabled: !root.deliveryLocked
        onClicked: root.finish()
      }
    }

  }

}
