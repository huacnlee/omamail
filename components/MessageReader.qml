import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../lib/Html.js" as Html
import "../lib/Message.js" as Mail

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
  required property color linkColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily
  property bool forcePlainText: false
  property real zoom: 1.0
  // A way back only means something when something is behind it. At desktop
  // width the list is on screen and clicking another row is the navigation;
  // in a single column the reader has replaced the list, so it needs one.
  property bool showBack: false
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
  // Already sanitised by the service, remote images and all removed. Qt's rich
  // text engine fetches an <img src="https://..."> for real, so leaving them in
  // would fire every tracking pixel in the message the instant it opened, and
  // would let a crafted one aim a request at whatever is listening on this
  // machine. They come back only when the reader asks, for this message alone.
  readonly property string rawHtml: service ? service.selectedHtml : ""
  // The parsed form of the same document. Fitting it to this window is done on
  // the way out, so this is rebuilt on every relayout without being reparsed.
  readonly property var bodyDocument: service ? service.selectedDocument : null
  readonly property int remoteImages: service ? service.selectedRemoteImages : 0
  readonly property bool remoteImagesAllowed: !!service && service.remoteImagesAllowed
  // Qt lays rich text out on the GUI thread, and this plugin lives inside the
  // shell that draws the whole desktop. A document past the bounds gets its
  // plain-text part instead, with a way to insist.
  readonly property bool tooHeavy: !!service && service.selectedTooHeavy
    && !root.forceRichAnyway
  readonly property bool htmlAvailable: rawHtml !== "" && !root.forcePlainText && !root.tooHeavy

  // Image markers only mean something when the plain text was made from the
  // HTML: a message that shipped its own text/plain part never had images in
  // it, and anything looking like a marker there is the sender's own words.
  readonly property string bodySource: service && service.selectedBody
    ? String(service.selectedBody.source || "") : ""
  readonly property var imageSources: service ? service.selectedImages : []

  // At a narrow window the reader gives up most of its own gutter, and the
  // sender's horizontal padding is stripped as well. Keyed off the flickable's
  // width rather than the text's, so the inset cannot feed back into itself.
  readonly property bool narrowBody: bodyFlick.width > 0
    && bodyFlick.width < Style.space(420)
  // One inset for the whole page. Giving the body a narrower one bought a few
  // pixels and cost the alignment: the message text started to the left of the
  // subject above it and the toolbar below, which reads as a mistake long
  // before it reads as extra room. The space is reclaimed from the sender's own
  // padding instead, which is where it was being wasted.
  readonly property int pageInset: narrowBody ? Style.space(8) : Style.space(14)
  readonly property int bodyInset: pageInset
  readonly property int bodyWidth: Math.max(80, bodyFlick.width - bodyInset * 2)
  // Quantised, because this is a dependency of the document itself: bound to
  // the exact width, dragging the splitter would rebuild and re-lay-out the
  // whole message on every frame.
  readonly property int imageWidth: Math.round(root.bodyWidth / 20) * 20

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
    anchors.margins: root.pageInset
    implicitHeight: (backBar.visible ? backBar.implicitHeight + Style.space(14) : 0)
      + headerColumn.implicitHeight

    BackBar {
      id: backBar
      visible: root.showBack
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
      anchors.top: backBar.visible ? backBar.bottom : parent.top
      anchors.topMargin: backBar.visible ? Style.space(10) : 0
      iconName: "star"
      filled: !!root.summary && root.summary.starred
      tooltipText: (root.summary && root.summary.starred ? "Unstar" : "Star") + " · s"
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
      anchors.top: backBar.visible ? backBar.bottom : parent.top
      anchors.topMargin: backBar.visible ? Style.space(14) : 0
      spacing: Style.space(4)

      Text {
        width: parent.width
        // A stranger wrote this. Qt's default AutoText switches a string that
        // looks like markup into rich text, and rich text with an <img> in it is
        // a fetch — the same beacon the message body is stripped of.
        textFormat: Text.PlainText
        text: root.summary ? root.summary.subject : ""
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.subtitle
        font.bold: true
        wrapMode: Text.WordWrap
      }

      Text {
        width: parent.width
        textFormat: Text.PlainText
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
        textFormat: Text.PlainText
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
    anchors.leftMargin: root.pageInset
    anchors.rightMargin: root.pageInset
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

  // Sits under the heavy-document notice when both are up: one says why the
  // message looks plain, the other why it looks bare, and they are different
  // answers to different questions.
  Rectangle {
    id: imageNotice
    visible: !!root.summary && root.htmlAvailable
      && !root.remoteImagesAllowed && root.remoteImages > 0
    anchors.top: heavyNotice.visible ? heavyNotice.bottom : headerBlock.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.leftMargin: root.pageInset
    anchors.rightMargin: root.pageInset
    anchors.topMargin: Style.space(8)
    implicitHeight: Style.space(30)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    border.width: 1
    border.color: Style.normalBorderFor(root.textColor, root.accentColor)

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(10)
      anchors.right: showImages.left
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: (root.remoteImages === 1 ? "1 image is blocked" : root.remoteImages + " images are blocked")
        + ": loading them tells the sender this message was opened"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      textFormat: Text.PlainText
      elide: Text.ElideRight
    }

    Button {
      id: showImages
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: "Show images"
      foreground: root.textColor
      bordered: false
      fontSize: Style.font.caption
      onClicked: if (root.service) root.service.showRemoteImages()
    }
  }

  Flickable {
    id: bodyFlick
    anchors.top: imageNotice.visible
      ? imageNotice.bottom
      : (heavyNotice.visible ? heavyNotice.bottom : headerBlock.bottom)
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: footerBackdrop.visible ? footerBackdrop.top : parent.bottom
    contentWidth: width
    contentHeight: bodyText.implicitHeight + Style.space(28)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    visible: !!root.summary
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    TextEdit {
      id: bodyText
      x: root.bodyInset
      y: Style.space(14)
      width: root.bodyWidth
      readOnly: true
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      // Rich text either way. The plain-text document is built here rather than
      // taken from the sender — escaped text, line breaks and marker links and
      // nothing else — so it stays cheap to lay out even for the messages that
      // fell back to plain text because their own markup was too heavy.
      textFormat: TextEdit.RichText
      text: root.htmlAvailable
        ? Html.documentFor(root.bodyDocument ? root.bodyDocument : root.rawHtml, ({
            foreground: root.textColor,
            background: root.backgroundColor,
            link: root.linkColor,
            quote: root.dimColor,
            padding: 0,
            maxImageWidth: root.imageWidth,
            compact: root.narrowBody
          }))
        : Html.plainTextDocument(root.service ? root.service.selectedBody.text : "",
            ({
              foreground: root.textColor,
              background: root.backgroundColor,
              link: root.linkColor
            }), root.bodySource === "html")
      color: root.textColor
      selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
      selectedTextColor: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Math.max(7, Math.round(Style.font.bodySmall * root.zoom))
      onLinkActivated: function(link) {
        var image = Html.imageLinkIndex(link)
        if (image > 0) {
          var sources = root.imageSources
          // A marker in a plain-text body opens the picture it stands for, and
          // "the picture" is whatever the sender wrote in the src. Opening one
          // is a fetch, so it obeys the same rule the document does.
          if (image <= sources.length) imagePopover.show(sources[image - 1])
          return
        }
        Qt.openUrlExternally(link)
      }

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

  // The toolbar sits on its own ground rather than on whatever happens to be
  // scrolled behind it. Transparent, the message ran underneath the icons and
  // through the rule, which read as text overlapping the controls.
  Rectangle {
    id: footerBackdrop
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: footer.implicitHeight + Style.space(10)
    color: root.backgroundColor
    visible: footer.visible

    // Edge to edge, not inset with the buttons: it separates the toolbar from
    // the message, and that division runs the full width of the window.
    PanelSeparator {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      foreground: root.textColor
    }
  }

  Column {
    id: footer
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.leftMargin: root.pageInset
    anchors.rightMargin: root.pageInset
    anchors.bottomMargin: Style.space(4)
    spacing: Style.space(4)
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
          textFormat: Text.PlainText
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

    // Icons rather than labels: six actions fit where six words would not.
    //
    // Split in two. What you do to the message — answer it, file it, throw it
    // away — sits on the left where reading ends. How you look at it is not
    // something you do to it, so it goes to the far right, out of the path of
    // the actions that change something.
    Item {
      width: parent.width
      implicitHeight: messageActions.implicitHeight

    Row {
      id: messageActions
      anchors.left: parent.left
      spacing: Style.space(2)

      IconButton {
        id: replyButton
        iconName: "reply"; tooltipText: "Reply · r"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.composeRequested("reply")
      }
      IconButton {
        iconName: "replyAll"; tooltipText: "Reply all · a"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.composeRequested("replyAll")
      }
      IconButton {
        iconName: "forward"; tooltipText: "Forward · f"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.composeRequested("forward")
      }

      // Answering a message and disposing of one are different intentions, and
      // one of them cannot be undone from here. The gap is wide enough that a
      // hand aiming at Forward cannot land on Archive.
      //
      // As tall as the buttons it stands between, taken from one of them rather
      // than from a constant: IconButton sizes itself from its icon, so a hard
      // number drifts. A one-pixel-high item in a Row aligns to the row's top
      // edge, which left the rule floating above the icons instead of level
      // with them.
      Item {
        width: Style.space(28)
        height: replyButton.height

        PanelSeparator {
          anchors.centerIn: parent
          width: 1
          height: Style.space(15)
          foreground: root.textColor
        }
      }

      // No archive button where the account has nowhere to archive to. On
      // IMAP that is a move to a folder, and a server without one would have
      // this quietly do nothing — or worse, delete.
      IconButton {
        visible: !root.service || root.service.canArchive
        iconName: "archive"; tooltipText: "Archive · e"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.actionRequested("archive")
      }
      IconButton {
        iconName: "trash"; tooltipText: "Move to trash · d"
        foreground: root.textColor; fontFamily: root.panelFontFamily
        onClicked: root.actionRequested("trash")
      }

    }

    // The distance across the bar is the separation here, so these need no rule
    // of their own.
    Row {
      anchors.right: parent.right
      anchors.verticalCenter: messageActions.verticalCenter
      spacing: Style.space(2)

      IconButton {
        visible: root.rawHtml !== ""
        iconName: "plain"
        tooltipText: root.forcePlainText ? "Show formatted" : "Show plain text"
        foreground: root.forcePlainText ? root.accentColor : root.dimColor
        hoverColor: root.textColor
        fontFamily: root.panelFontFamily
        onClicked: root.togglePlainTextRequested()
      }
      // Only Gmail has a web mailbox this plugin knows the address of.
      IconButton {
        visible: !root.service || root.service.canOpenOnWeb
        iconName: "browser"; tooltipText: "Open in browser"
        foreground: root.dimColor; hoverColor: root.textColor
        fontFamily: root.panelFontFamily
        onClicked: if (root.service && root.summary) root.service.openInBrowser(root.summary.id)
      }
    }
    }
  }

  ImagePopover {
    id: imagePopover
    textColor: root.textColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
  }
}
