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
  property bool allowRemoteImages: false
  property bool forcePlainText: false
  property bool showBack: false

  signal backRequested()
  signal loadImagesRequested()
  signal togglePlainTextRequested()
  signal composeRequested(string mode)
  signal actionRequested(string action)

  readonly property var summary: service ? service.selectedMessage : null
  readonly property string rawHtml: service ? service.selectedHtml : ""
  readonly property var sanitized: Html.sanitize(rawHtml,
    ({ allowRemoteImages: root.allowRemoteImages }))
  readonly property bool htmlAvailable: rawHtml !== "" && !root.forcePlainText
  readonly property int blockedImages: root.htmlAvailable ? root.sanitized.blockedImages : 0

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

  // Remote images are a tracking channel, so the choice is explicit and it is
  // per message: the banner comes back on the next one.
  Rectangle {
    id: imageBanner
    visible: root.blockedImages > 0
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
      anchors.verticalCenter: parent.verticalCenter
      text: root.blockedImages === 1
        ? "1 remote image blocked"
        : root.blockedImages + " remote images blocked"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }

    Button {
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: "Show images"
      foreground: root.textColor
      bordered: false
      fontSize: Style.font.caption
      onClicked: root.loadImagesRequested()
    }
  }

  // ------------------------------------------------------------------ body

  Flickable {
    id: bodyFlick
    anchors.top: imageBanner.visible ? imageBanner.bottom : headerBlock.bottom
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
