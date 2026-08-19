import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../Html.js" as Html
import "../Message.js" as Mail

// The right column. The body goes through Qt's own rich text engine — a real
// HTML renderer, not a browser — after Html.sanitize has removed what Qt would
// render badly and the remote images that would otherwise fire every tracking
// pixel in the message the instant it opens.
Item {
  id: root

  required property var service
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property color linkColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily
  property bool forcePlainText: false
  property real zoom: 1.0
  // Set by the reader itself when a document is too heavy to lay out, and
  // cleared by the user asking for it anyway.
  property bool forceRichAnyway: false

  signal backRequested()
  signal togglePlainTextRequested()
  signal zoomRequested(real step)
  signal zoomResetRequested()
  signal composeRequested(string mode)
  signal actionRequested(string action)

  readonly property var summary: service ? service.selectedMessage : null
  // Already sanitised by the service, on a worker thread where the decode
  // happens. Images load: Qt's rich text engine fetches them for real, so the
  // sender learns when the message was opened — a deliberate trade for mail
  // that looks like mail.
  readonly property string rawHtml: service ? service.selectedHtml : ""
  // Qt lays rich text out on the GUI thread, and this plugin lives inside the
  // shell that draws the whole desktop. A document past the bounds gets its
  // plain-text part instead, with a way to insist.
  readonly property bool tooHeavy: !!service && service.selectedTooHeavy
    && !root.forceRichAnyway
  readonly property bool htmlAvailable: rawHtml !== "" && !root.forcePlainText && !root.tooHeavy

  ReaderBlankSlate {
    anchors.fill: parent
    visible: !root.summary && !(root.service && root.service.detailLoading)
    service: root.service
    textColor: root.textColor
    accentColor: root.accentColor
    dimColor: root.dimColor
    dimmerColor: root.dimmerColor
    panelFontFamily: root.panelFontFamily
  }

  ReaderSkeleton {
    anchors.fill: parent
    visible: !root.summary && !!root.service && root.service.detailLoading
    textColor: root.textColor
    panelFontFamily: root.panelFontFamily
  }

  // --------------------------------------------------------------- headers

  Item {
    id: headerBlock
    visible: !!root.summary
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(14)
    implicitHeight: backBar.implicitHeight + Style.space(6) + headerColumn.implicitHeight

    BackBar {
      id: backBar
      anchors.left: parent.left
      anchors.top: parent.top
      textColor: root.textColor
      dimColor: root.dimColor
      panelFontFamily: root.panelFontFamily
      onActivated: root.backRequested()
    }

    IconButton {
      id: starButton
      anchors.right: parent.right
      anchors.top: backBar.bottom
      anchors.topMargin: Style.space(2)
      iconName: "star"
      filled: !!root.summary && root.summary.starred
      tooltipText: root.summary && root.summary.starred ? "Unstar" : "Star"
      foreground: root.summary && root.summary.starred ? root.accentColor : root.dimColor
      hoverColor: root.accentColor
      fontFamily: root.panelFontFamily
      onClicked: if (root.service && root.summary) root.service.toggleStar(root.summary.id)
    }

    Column {
      id: headerColumn
      anchors.left: parent.left
      anchors.right: starButton.left
      anchors.rightMargin: Style.space(8)
      anchors.top: backBar.bottom
      anchors.topMargin: Style.space(6)
      spacing: Style.space(4)

      Text {
        width: parent.width
        text: root.summary ? root.summary.subject : ""
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.subtitle
        font.bold: true
        wrapMode: Text.WordWrap
      }

      Text {
        width: parent.width
        text: root.summary
          ? root.summary.from.display + "  <" + root.summary.from.email + ">"
          : ""
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideRight
      }

      Text {
        width: parent.width
        text: root.summary
          ? "to " + Mail.formatAddressList(root.summary.to, 3) + " · " + root.summary.fullTime
          : ""
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }
  }

  // ------------------------------------------------------------------ body

  Rectangle {
    id: heavyNotice
    visible: root.tooHeavy
    anchors.top: headerBlock.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.leftMargin: Style.space(14)
    anchors.rightMargin: Style.space(14)
    anchors.topMargin: Style.space(8)
    implicitHeight: Style.space(30)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.normalBorderFor(root.textColor, root.accentColor)

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(10)
      anchors.right: showAnyway.left
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: "Showing the plain text: this message is heavy enough to stall the shell"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }

    Button {
      id: showAnyway
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: "Show anyway"
      foreground: root.textColor
      bordered: false
      fontSize: Style.font.caption
      onClicked: root.forceRichAnyway = true
    }
  }

  Flickable {
    id: bodyFlick
    anchors.top: heavyNotice.visible ? heavyNotice.bottom : headerBlock.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: footer.top
    contentWidth: width
    contentHeight: bodyText.implicitHeight + Style.space(28)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    visible: !!root.summary
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    TextEdit {
      id: bodyText
      x: Style.space(14)
      y: Style.space(14)
      width: bodyFlick.width - Style.space(28)
      readOnly: true
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      textFormat: root.htmlAvailable ? TextEdit.RichText : TextEdit.PlainText
      text: root.htmlAvailable
        ? Html.documentFor(root.rawHtml, ({
            foreground: root.textColor,
            background: root.backgroundColor,
            link: root.linkColor,
            quote: root.dimColor,
            padding: 0
          }))
        : (root.service ? root.service.selectedBody.text : "")
      color: root.textColor
      selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
      selectedTextColor: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Math.max(7, Math.round(Style.font.bodySmall * root.zoom))
      onLinkActivated: function(link) { Qt.openUrlExternally(link) }

      // NoButton so selecting text still works; this exists only to turn the
      // I-beam into a hand while a link is under the pointer.
      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.NoButton
        cursorShape: bodyText.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.IBeamCursor
        onWheel: function(wheel) {
          if (!(wheel.modifiers & Qt.ControlModifier)) {
            wheel.accepted = false
            return
          }
          root.zoomRequested(wheel.angleDelta.y > 0 ? 0.1 : -0.1)
          wheel.accepted = true
        }
      }
    }
  }

  // ---------------------------------------------------------------- footer

  Column {
    id: footer
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(14)
    spacing: Style.space(6)
    visible: !!root.summary

    Repeater {
      model: root.service ? root.service.selectedAttachments : []

      Row {
        required property var modelData
        spacing: Style.space(6)

        ActionIcon {
          anchors.verticalCenter: parent.verticalCenter
          name: "attachment"
          iconSize: Style.font.iconSmall
          color: root.dimColor
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.filename
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: Mail.formatSize(modelData.size)
          color: root.dimmerColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }

    PanelSeparator {
      width: parent.width
      foreground: root.textColor
    }

    // Icons rather than labels: six actions fit where six words would not, and
    // the destructive one is set apart by the rule and by taking urgent.
    Row {
      spacing: Style.space(2)

      IconButton {
        iconName: "reply"; tooltipText: "Reply"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.composeRequested("reply")
      }
      IconButton {
        iconName: "replyAll"; tooltipText: "Reply all"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.composeRequested("replyAll")
      }
      IconButton {
        iconName: "forward"; tooltipText: "Forward"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.composeRequested("forward")
      }

      Item {
        width: Style.space(13); height: 1
        PanelSeparator {
          anchors.centerIn: parent
          width: 1; height: Style.space(16)
          foreground: root.textColor
        }
      }

      IconButton {
        iconName: "archive"; tooltipText: "Archive"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.actionRequested("archive")
      }
      IconButton {
        iconName: "trash"; tooltipText: "Move to trash"
        foreground: root.urgentColor; fontFamily: root.panelFontFamily
        onClicked: root.actionRequested("trash")
      }

      Item {
        width: Style.space(13); height: 1
        PanelSeparator {
          anchors.centerIn: parent
          width: 1; height: Style.space(16)
          foreground: root.textColor
        }
      }

      IconButton {
        visible: root.rawHtml !== ""
        iconName: "plain"
        tooltipText: root.forcePlainText ? "Show formatted" : "Show plain text"
        foreground: root.forcePlainText ? root.accentColor : root.dimColor
        hoverColor: root.textColor
        fontFamily: root.panelFontFamily
        onClicked: root.togglePlainTextRequested()
      }
      IconButton {
        iconName: "browser"; tooltipText: "Open in browser"
        foreground: root.dimColor; hoverColor: root.textColor
        fontFamily: root.panelFontFamily
        onClicked: if (root.service && root.summary) root.service.openInBrowser(root.summary.id)
      }
    }
  }
}
