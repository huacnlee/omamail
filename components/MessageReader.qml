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
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily
  property bool forcePlainText: false
  property bool showBack: false

  signal backRequested()
  signal togglePlainTextRequested()
  signal composeRequested(string mode)
  signal actionRequested(string action)

  readonly property var summary: service ? service.selectedMessage : null
  readonly property string rawHtml: service ? service.selectedHtml : ""
  // Images load. Qt's rich text engine fetches them for real, so the sender
  // learns when the message was opened — a deliberate trade for mail that
  // looks like mail.
  readonly property var sanitized: Html.sanitize(rawHtml, ({ allowRemoteImages: true }))
  readonly property bool htmlAvailable: rawHtml !== "" && !root.forcePlainText

  Text {
    anchors.centerIn: parent
    visible: !root.summary
    text: root.service && root.service.detailLoading ? "Opening…" : "Select a message"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
  }

  // --------------------------------------------------------------- headers

  Item {
    id: headerBlock
    visible: !!root.summary
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(14)
    implicitHeight: headerColumn.implicitHeight

    IconButton {
      id: backButton
      anchors.left: parent.left
      anchors.top: parent.top
      visible: root.showBack
      iconName: "back"
      tooltipText: "Back to the list"
      foreground: root.dimColor
      hoverColor: root.textColor
      fontFamily: root.panelFontFamily
      onClicked: root.backRequested()
    }

    IconButton {
      id: starButton
      anchors.right: parent.right
      anchors.top: parent.top
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
      anchors.left: backButton.visible ? backButton.right : parent.left
      anchors.leftMargin: backButton.visible ? Style.space(6) : 0
      anchors.right: starButton.left
      anchors.rightMargin: Style.space(8)
      anchors.top: parent.top
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

  Flickable {
    id: bodyFlick
    anchors.top: headerBlock.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: footer.top
    anchors.margins: Style.space(14)
    contentWidth: width
    contentHeight: bodyText.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    visible: !!root.summary
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    // TextEdit rather than Text so the body can be selected and copied, which
    // is most of what anyone does with a message they did not write.
    TextEdit {
      id: bodyText
      width: bodyFlick.width
      readOnly: true
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      textFormat: root.htmlAvailable ? TextEdit.RichText : TextEdit.PlainText
      text: root.htmlAvailable
        ? Html.documentFor(root.sanitized.html, ({
            foreground: root.textColor,
            background: root.backgroundColor,
            link: root.accentColor,
            quote: root.dimColor
          }))
        : (root.service ? root.service.selectedBody.text : "")
      color: root.textColor
      selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
      selectedTextColor: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      onLinkActivated: function(link) { Qt.openUrlExternally(link) }

      // NoButton so selecting text still works; this exists only to turn the
      // I-beam into a hand while a link is under the pointer.
      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.NoButton
        cursorShape: bodyText.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.IBeamCursor
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
