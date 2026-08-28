import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail
import "../../message/Html.js" as Html

// Three ways of reading one message, and the two things that must stay true
// while moving between them: nothing is asked of the network, and the message
// on screen is still the message that was open.
//
// The reading column is here too, because how wide it is and where it sits are
// decided against a font Qt measures — which is the half of that decision no
// node test can make.
Item {
  width: 900
  height: 600

  readonly property string senderHtml: '<table width="600" align="center" bgcolor="#ffeedd"'
    + ' background="https://static.example.net/tile.png" class="card"><tr>'
    + '<td style="padding:24px;font-size:28px;font-family:Graphik;color:#123456">'
    + 'Activity on Sprint board</td>'
    + '</tr><tr><td style="padding:0 24px">Person 1 moved 4 cards. '
    + '<a href="https://example.com/board">Open the board</a></td></tr></table>'

  readonly property var rendered: Html.sanitize(senderHtml, ({ withReader: true }))

  QtObject {
    id: mailService

    // Every trip to the network a body could cause. Reading mode is built
    // beside the other two off one parse, so choosing between them must move
    // none of these.
    property int fetches: 0
    property int renders: 0

    property string selectedId: "message-9"
    property var selectedMessage: ({
      id: "message-9",
      subject: "Activity on Sprint board",
      from: ({ display: "Boards", email: "boards@example.com" }),
      to: [({ display: "Reader", email: "reader@example.com" })],
      fullTime: "24 August 2026",
      starred: false
    })
    property bool detailLoading: false
    property bool detailPainted: true
    property string selectedHtml: rendered.html
    property var selectedDocument: rendered.document
    property var selectedReaderDocument: rendered.reader.document
    property bool selectedReaderTooHeavy: rendered.reader.tooHeavy
    property bool selectedReaderEmpty: rendered.reader.empty
    property int selectedRemoteImages: rendered.remoteImages
    property bool remoteImagesAllowed: false
    property bool selectedTooHeavy: rendered.tooHeavy
    property string unsubscribeLabel: ""
    property string unsubscribeDetail: ""
    property bool unsubscribing: false
    property var selectedBody: ({ text: "Activity on Sprint board", source: "html" })
    property var selectedImages: []
    property var selectedInvite: null
    property string selectedResponse: ""
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: true
    property bool canOpenOnWeb: false
    property var selectedAttachments: []

    function getMessage() { fetches++ }
    function showRemoteImages() { renders++ }
  }

  Omamail.MessageReader {
    id: reader
    // Sized rather than anchored: the panel's width is what these tests move.
    width: 900
    height: 600
    service: mailService
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    linkColor: Qt.rgba(0.3, 0.7, 1, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    leadingBoundaryOverlap: 0
    dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    panelFontFamily: "monospace"
    bodyMode: "reader"
    onBodyModeRequested: function(mode) { reader.bodyMode = mode }
  }

  TestCase {
    name: "ReaderMode"
    when: windowShown

    function found(item, type) {
      if (!item) return null
      if (item.toString().indexOf(type) === 0) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var hit = found(values[i], type)
        if (hit) return hit
      }
      return null
    }

    function named(item, name) {
      if (!item) return null
      if (item.objectName === name) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var hit = named(values[i], name)
        if (hit) return hit
      }
      return null
    }

    function body() {
      var edit = found(reader, "QQuickTextEdit")
      verify(edit, "the reader draws its message in a TextEdit")
      return edit
    }

    function init() {
      reader.bodyMode = "reader"
      reader.forceRichAnyway = false
      reader.alwaysRenderHeavyMessages = false
      mailService.fetches = 0
      mailService.renders = 0
    }

    function test_reading_is_what_a_message_opens_as() {
      compare(reader.shownMode, "reader")
      var text = body().text
      verify(text.indexOf("Activity on Sprint board") > 0, "the message is in it")
      verify(text.indexOf("https://example.com/board") > 0, "and so is its link")
      verify(text.indexOf("<h2") > 0, "the sender's big type is the reader's heading")

      // Read back off the document Qt built rather than off the string handed
      // to it: the document is the thing that would have made the fetch, and
      // what it does not contain it cannot ask for. Everything below is the
      // sender's presentation, and none of it is in there — the ground, the
      // ink, the face, the class, and the address the background pointed at.
      verify(text.indexOf("static.example.net") < 0, "a sender resource reached the renderer")
      verify(text.indexOf("#ffeedd") < 0, "the sender's ground reached the renderer")
      verify(text.indexOf("#123456") < 0, "the sender's ink reached the renderer")
      verify(text.indexOf("Graphik") < 0, "the sender's face reached the renderer")
      verify(text.indexOf("class=") < 0, "a sender class reached the renderer")
      verify(text.indexOf("url(") < 0, "a CSS resource reached the renderer")
    }

    function test_the_body_is_separated_from_the_header() {
      verify(body().y >= 20,
        "mail content has its own section gap below the sender metadata")
    }

    function test_changing_mode_asks_nothing_of_the_network() {
      var readerText = body().text
      reader.bodyModeRequested("original")
      compare(reader.bodyMode, "original")
      compare(reader.shownMode, "original")
      verify(body().text !== readerText, "a different document is on screen")
      verify(body().text.indexOf("Person 1 moved 4 cards") > 0)

      reader.bodyModeRequested("plain")
      compare(reader.shownMode, "plain")
      verify(body().text.indexOf("Activity on Sprint board") > 0)

      reader.bodyModeRequested("reader")
      compare(body().text, readerText, "and back is the same document, not a new one")

      compare(mailService.fetches, 0, "no message was read again")
      compare(mailService.renders, 0, "and nothing was rendered again")
      compare(mailService.selectedId, "message-9", "the open message never changed")
      compare(reader.summary.id, "message-9")
    }

    function test_the_reading_column_is_bounded_and_centred() {
      compare(reader.shownMode, "reader")
      var edit = body()
      verify(edit.width < reader.bodyWidth,
        "a wide panel does not become a wide line of text")
      verify(reader.bodyOffset > 0, "and the column is centred in what is left")
      // Sixty-five to seventy-five characters of the face it is drawn in.
      var perCharacter = reader.readingMeasure / 70
      var characters = edit.width / perCharacter
      verify(characters > 60 && characters < 80, "the measure is a readable one: " + characters)

      // The other two start at the page inset, because a sender's own layout
      // and a plain-text body both begin at the left edge.
      reader.bodyMode = "original"
      compare(reader.bodyOffset, 0)
      reader.bodyMode = "plain"
      compare(reader.bodyOffset, 0)
    }

    function test_a_narrow_panel_gives_the_column_everything() {
      reader.width = 420
      compare(reader.bodyOffset, 0, "there is nothing spare to centre in")
      compare(body().width, reader.bodyWidth)
      verify(body().x + body().width <= reader.width, "and nothing runs off the panel")
      reader.width = 900
      verify(reader.bodyOffset > 0, "and the column comes back when there is room again")
    }

    function test_view_modes_are_one_segmented_toolbar_control() {
      mailService.canOpenOnWeb = true
      var toolbar = named(reader, "readerToolbar")
      var viewTools = named(reader, "readerViewTools")
      var track = named(reader, "bodyModeTrack")
      var segments = named(reader, "bodyModeSegments")
      var web = named(reader, "openWebButton")
      verify(toolbar && viewTools && track && segments && web)
      compare(segments.spacing, 0, "segments share edges instead of reading as loose buttons")
      compare(track.border.width, 1, "the modes share one enclosing border")
      compare(viewTools.controlsAligned, true,
        "the segmented toggle and Open Web are aligned on the toolbar: track="
          + track.y + "/" + track.height + " web=" + web.y + "/" + web.height
          + " group=" + viewTools.height)
      compare(web.y, track.y,
        "Open Web starts on the same toolbar line as the segmented control")
      compare(web.height, track.height,
        "Open Web has the same toolbar control box, not only the same centre")

      reader.width = 300
      tryCompare(toolbar, "stacked", true)
      verify(track.y >= 0 && web.y >= 0)
      reader.width = 900
      tryCompare(toolbar, "stacked", false)
      mailService.canOpenOnWeb = false
    }

    function test_event_card_keeps_the_interface_width_in_reader_mode() {
      mailService.selectedInvite = ({ summary: "Planning", attendees: [] })
      var card = named(reader, "eventCard")
      verify(card && card.visible)
      compare(card.x, reader.bodyInset)
      compare(card.width, reader.bodyWidth,
        "the app's event card does not inherit the mail reading measure")
      reader.bodyMode = "original"
      compare(card.x, reader.bodyInset)
      compare(card.width, reader.bodyWidth)
      mailService.selectedInvite = null
    }

    function test_zoom_moves_the_type_and_the_column_with_it() {
      var wasFont = body().font.pixelSize
      var wasWidth = body().width
      reader.zoom = 2.0
      verify(body().font.pixelSize > wasFont, "the message is read at the size asked for")
      verify(body().width >= wasWidth, "and the column follows the measure")
      verify(body().width <= reader.bodyWidth, "without leaving the panel")
      verify(body().text.indexOf("Activity on Sprint board") > 0)

      // Far past what the panel can hold, the column stops rather than
      // overflowing, and stays where the page inset put it.
      reader.zoom = 4.0
      compare(body().width, reader.bodyWidth)
      compare(reader.bodyOffset, 0)
      reader.zoom = 1.0
      compare(body().font.pixelSize, wasFont)
      compare(body().width, wasWidth)
    }

    function test_a_message_too_heavy_to_draw_says_so_rather_than_showing_nothing() {
      mailService.selectedReaderTooHeavy = true
      mailService.selectedTooHeavy = true
      compare(reader.shownMode, "plain")
      compare(reader.tooHeavy, true, "and the notice explains why")
      reader.forceRichAnyway = true
      compare(reader.shownMode, "reader")
      compare(reader.tooHeavy, false)
      reader.forceRichAnyway = false
      reader.alwaysRenderHeavyMessages = true
      compare(reader.shownMode, "reader", "the persistent preference also skips the refusal")
      compare(reader.tooHeavy, false)
      reader.bodyMode = "original"
      compare(reader.shownMode, "original", "the preference applies to the sender's document too")
      mailService.selectedReaderTooHeavy = false
      mailService.selectedTooHeavy = false
    }

    function test_a_message_with_nothing_to_read_says_so() {
      mailService.selectedReaderEmpty = true
      compare(reader.shownMode, "original")
      compare(reader.bodyMode, "reader", "and the choice still stands for the next message")
      verify(reader.readingEmpty,
        "a message that arrives in a layout unlike every other has to say why")
      verify(!reader.tooHeavy, "and it is not the heavy-document answer")
      mailService.selectedReaderEmpty = false
      compare(reader.shownMode, "reader")
      verify(!reader.readingEmpty)
    }
  }
}
