import QtQuick
import qs.Commons
import qs.Ui
import "../providers/Registry.js" as Provider
import "../account/Model.js" as Model

// What a setup page opens with: the service's own mark, its name, and one line
// saying what connecting it involves.
//
// The mark and the brand word in the heading are one link to the service's
// website, because that is where everything this window deliberately does not
// do still lives — HEY's Screener, Gmail's filters and forwarding. Only the
// brand word: a heading that is entirely a link reads as one somebody made
// clickable by accident, and the sentence around it is not about the website.
//
// It is also the one place in the panel where a pointing-hand cursor is right.
// This is a link in the ordinary sense rather than a native control, and it is
// underlined for the same reason — the affordance has to be there before the
// pointer is, and colour alone must never carry it.
//
// Shared by both setup pages rather than written twice: they ask the same
// question in the same place, and the two heroes had already drifted once.
Item {
  id: root

  required property string providerId
  required property string title
  required property string detail
  required property color textColor
  required property color dimColor
  required property string panelFontFamily

  signal websiteRequested()

  readonly property string website: Provider.webHomeUrl(providerId)
  readonly property bool linked: website !== ""
  // The heading, cut around the one word in it that is the link.
  readonly property var parts: Model.splitBrand(title, Provider.badge(providerId))

  implicitHeight: Math.max(logo.height, heroText.implicitHeight)

  ProviderLogo {
    id: logo
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.topMargin: Style.space(2)
    logo: Provider.logo(root.providerId)

    HoverHandler {
      id: logoHover
      enabled: root.linked
      cursorShape: Qt.PointingHandCursor
    }

    TapHandler {
      enabled: root.linked
      onTapped: root.websiteRequested()
    }

    PanelToolTip {
      text: "Open " + Provider.badge(root.providerId) + " in your browser"
      visible: logoHover.hovered
    }
  }

  Column {
    id: heroText
    anchors.left: logo.right
    anchors.leftMargin: Style.space(14)
    anchors.right: parent.right
    anchors.top: parent.top
    spacing: Style.space(4)

    // No spacing: the gaps around the brand word are the ones the sentence
    // already had, and a Row that added its own would space "Add a HEY mailbox"
    // twice.
    Row {
      spacing: 0

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.parts.before !== ""
        text: root.parts.before
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
      }

      LinkLabel {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.parts.brand !== "" && root.linked
        text: root.parts.brand
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        tooltipText: "Open " + Provider.badge(root.providerId) + " in your browser"
        onActivated: root.websiteRequested()
      }

      // The same word, plain, for a provider with no website to point at.
      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.parts.brand !== "" && !root.linked
        text: root.parts.brand
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.parts.after !== ""
        text: root.parts.after
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
      }
    }

    Text {
      width: parent.width
      text: root.detail
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }
  }
}
