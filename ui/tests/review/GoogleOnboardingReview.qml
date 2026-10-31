import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../.." as Omamail
import Quickshell
import Quickshell.Io
import qs.Commons as Commons

// Native-window evidence fixture. Service responses are synthetic; the views,
// helper process lifecycle, host navigation and installed qs.Ui are real.
Item {
  id: fixture
  property string runDirectory: Quickshell.env("OMAMAIL_REVIEW_DIR")
  property string evidenceTheme: "dark"
  property string caption: "Synthetic UI walkthrough — Google and package responses are simulated"
  property string boundary: ""
  property bool legacy: Quickshell.env("OMAMAIL_REVIEW_BEFORE") === "1"
  width: 1200
  height: 900

  QtObject {
    id: fakeShell
    property var hidden: []
    function hide(id) {
      var next = hidden.slice()
      next.push(String(id || ""))
      hidden = next
      app.close()
    }
  }

  QtObject { id: fakeBackend; property bool ready: true; function call(method, params, callback) { callback({}, "Synthetic backend") } }

  QtObject {
    id: fakeAuth

    property var backend: fakeBackend
    property bool refreshBusy: false
    property bool sessionBusy: false
    property string accountId: ""
    signal credentialsSaved()
    function reloadCredentials() {}
    property bool credentialsPresent: false
    property bool loggedIn: false
    property bool loginBusy: false
    property bool toolsChecked: true
    property bool toolsPresent: true
    property bool credentialsWriteBusy: false
    property var missingTools: []
    property string lastError: ""
    property string clientId: ""
    property string clientDescription: ""
    property string credentialsPath: ""
    property var credentials: null
    property var settings: ({
      imapHost: "imap.example.org", imapPort: 993,
      smtpHost: "smtp.example.org", smtpPort: 465,
      username: "", aliases: [], insecure: false
    })

    function recheck() {}
    function saveCredentials() {}
  }

  QtObject {
    id: mailService
    property bool diagnosing: false
    property int diagnosisCalls: 0
    function diagnoseError() { diagnosisCalls++; diagnosing = true }

    property bool ready: false
    property bool anyAccountReady: false
    property bool hasSavedAccounts: false
    property bool sendPending: false
    property bool sending: false
    property bool windowOpen: false
    property bool sidebarCollapsed: false
    property bool alwaysShowImages: false
    property bool unifiedCalendarView: false
    property bool selectedReaderEmpty: false
    property bool selectedReaderTooHeavy: false
    property bool selectedTooHeavy: false
    property bool detailLoading: false
    property bool detailPainted: false
    property bool canOpenOnWeb: false
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: true
    property bool canStar: true
    property bool canSpam: true
    property bool canTrash: true
    property bool canMarkRead: true
    property bool canMarkUnread: true
    property bool accountDraftOpen: false
    property string signInProgress: ""
    property string accountName: ""
    property bool standalone: false
    property var backend: fakeBackend
    property int signIns: 0
    property int cancelCalls: 0
    property int accountSwitches: 0
    function signIn() { signIns++; fakeAuth.lastError=""; fakeAuth.loginBusy=true; fixture.boundary="Google permission approval" }
    function cancelSignIn() { cancelCalls++; fakeAuth.loginBusy=false; fixture.boundary="" }
    function signOut() { fakeAuth.loggedIn=false }
    function openProviderWebsite(id) {}
    function openConsentScreen() {}
    property int sendSecondsRemaining: 10
    property int accountCount: 1
    property int inboxUnread: 0
    property real bodyZoom: 1
    property string bodyMode: "reader"
    property string providerId: ""
    property string pluginDir: fixture.runDirectory
    property string accountEmail: ""
    property string accountAddress: ""
    property string activeAccountId: ""
    property string mailboxKey: "inbox"
    property string searchQuery: ""
    property string rawQuery: ""
    property string selectedId: ""
    property string lastError: ""
    property string actionStatus: ""
    property string syncedLabel: ""
    property string recipientContactStatus: ""
    property var auth: fakeAuth
    property var accountSummaries: [{ provider: "imap", email: "me@example.com" }]
    property var mailboxes: []
    property var labels: []
    property var messages: []
    property var selectedAttachments: []
    property var selectedInvite: null
    property var selectedResponse: ""
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var calendarController: null
    property bool noCalendars: false
    property var selectedBody: ({ text: "Original body", source: "plain" })
    property var selectedMessage: null
    property var unavailableActions: []

    property var log: []
    property var lastSavedDraft: null
    property bool refuseMove: false

    signal accountAdded()
    signal replySent()

    function record(text) {
      var next = log.slice()
      next.push(text)
      log = next
    }
    function count(text) {
      var n = 0
      for (var i = 0; i < log.length; i++) if (log[i] === text) n++
      return n
    }
    function editingIndex() { return 0 }
    function addAccount(provider) {
      record("add:" + String(provider || ""))
      accountCount += 1
      accountAdded()
    }
    function configureCurrentAccount(values) {
      record("configure:" + String(values.provider || ""))
      if (values.provider !== undefined) providerId = String(values.provider)
      if (values.email !== undefined) fakeAuth.accountId=String(values.email)
      if (values.label !== undefined) accountName=String(values.label)
      return true
    }
    function discardCurrentDraft() {
      record("discard")
      if (accountCount > 1) accountCount -= 1
    }
    function switchToIndex(_index) { accountSwitches++; return true }
    function selectMailbox(key) {
      mailboxKey = String(key || "")
      record("mailbox:" + mailboxKey)
    }
    function search(query) {
      searchQuery = String(query || "")
      record("search:" + searchQuery)
    }
    function preferredSendAs(_recipients) { return null }
    function refreshRecipientContacts() {}
    function cursorOffset(_id, _delta) { return "" }
    function clearSelection() {
      selectedId = ""
      record("clear")
    }
    function select(id) {
      selectedId = String(id || "")
      selectedMessage = null
      selectedBody = ({ text: "", source: "" })
      selectedAttachments = []
      detailPainted = false
      detailLoading = true
    }
    // What the fetch would deliver, delivered by the test when it wants it.
    function land() {
      detailLoading = false
      detailPainted = true
      selectedMessage = ({
        id: selectedId,
        messageId: "<" + selectedId + "@example.com>",
        threadId: "thread-1",
        subject: "One",
        from: ({ email: "sender@example.com", display: "Sender" }),
        replyTo: ({ email: "sender@example.com" }),
        to: [], cc: [], bcc: [],
        fullTime: "today"
      })
      selectedBody = ({ text: "Original body", source: "plain" })
    }
    function loadAttachments(_messageId, _attachments, callback) { callback([], "") }
    function send(_fields) { return true }
    function undoSend() { return false }
    function saveDraft(fields, callback) {
      lastSavedDraft = fields
      record("saveDraft")
      callback("draft-1", "")
    }
    function refresh() {}
    function fail(text) { lastError = String(text || "") }
    function note(text) { actionStatus = String(text || "") }
    function act(id, action) {
      record("act:" + String(action || "") + ":" + String(id || ""))
      return true
    }
    function refuseUnavailableAction(action) {
      record("guard:" + String(action || ""))
      if (!refuseMove) return false
      note("HEY has no destination you can name")
      return true
    }
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }


  // This fixture uses production App.qml and native Quickshell windows. Only
  // the mail service and external Google/package responses are synthetic.
  function nodes(start, found, depth) {
    if (!start || depth > 30 || found.indexOf(start) >= 0) return
    found.push(start)
    var children = start.data || start.children || []
    for (var i=0;i<children.length;i++) nodes(children[i], found, depth+1)
    if (start.contentItem) nodes(start.contentItem, found, depth+1)
  }
  function all() { var found=[];nodes(app,found,0);return found }
  function named(name) {
    var found=all()
    for(var i=0;i<found.length;i++) if(found[i].objectName===name) return found[i]
    if(name === "provider-gmail")
      for(var j=0;j<found.length;j++) if(found[j].modelData === "gmail") return found[j]
    return null
  }
  function appWindow() {
    var found=all()
    for(var i=0;i<found.length;i++) if(found[i].title==="Omamail" || String(found[i].title||"").indexOf("OmaMail review")===0) return found[i]
    return null
  }
  function page() { var p=named("setup-page");return p ? p.item : null }
  function writeControl(value) { control.setText(JSON.stringify(value)) }
  FileView { id:control; path: fixture.runDirectory+"/control.json"; atomicWrites:true }
  FileView { id:lightPalette; path:"/usr/share/omarchy/themes/catppuccin-latte/colors.toml" }
  FileView { id:darkPalette; path:"/usr/share/omarchy/themes/tokyo-night/colors.toml" }
  function palette(theme) {
    fixture.evidenceTheme=theme
    // A user's dark-theme control overrides must not leak into the light pass.
    Commons.Color.loadUserShell("")
    Commons.Color.loadShell("")
    Commons.Color.loadColors(theme==="light" ? lightPalette.text() : darkPalette.text())
  }
  function reset(theme, width, height) {
    if(page() && typeof page().prepareToLeave==="function") page().prepareToLeave()
    writeControl({missingTools:["Google Cloud CLI","uv"], action:""})
    fakeAuth.credentialsPresent=false;fakeAuth.loggedIn=false;fakeAuth.loginBusy=false
    fakeAuth.credentialsWriteBusy=false;fakeAuth.accountId="";fakeAuth.clientId="";fakeAuth.credentials={}
    fakeAuth.lastError="";fakeAuth.clientDescription=""
    mailService.ready=false;mailService.anyAccountReady=false;mailService.hasSavedAccounts=false
    mailService.accountEmail="";mailService.accountAddress="";mailService.accountName="";mailService.providerId=""
    mailService.signIns=0;mailService.cancelCalls=0;mailService.accountSwitches=0
    fakeShell.hidden=[];fixture.boundary=""
    app.navUntouched=true;app.resetNavigation();app.open("{}")
    palette(theme)
    var win=appWindow()
    if(win) { win.implicitWidth=width;win.implicitHeight=height;win.title="OmaMail review — synthetic account"; evidenceLabel.parent=win.contentItem }
  }
  function selected() {
    fakeAuth.credentials={personal:true,ownerEmail:"owner@example.com",clientId:"123-synthetic.apps.googleusercontent.com"}
    fakeAuth.clientId=fakeAuth.credentials.clientId;fakeAuth.credentialsPresent=true
    fakeAuth.clientDescription="Personal app · owner@example.com"
    fakeAuth.accountId="owner@example.com"
  }
  IpcHandler {
    target: "omamailReview"
    function reset(theme:string,width:int,height:int):void { fixture.reset(theme,width,height) }
    function caption(text:string):void { fixture.caption=text }
    function provider():void { app.chooseProvider("gmail") }
    function locate(name:string):string {
      var item=fixture.named(name)
      if(!item) return "null"
      var pt=item.mapToGlobal ? item.mapToGlobal(item.width/2,item.height/2) : Qt.point(0,0)
      return JSON.stringify({name:name,x:pt.x,y:pt.y,width:item.width,height:item.height,visible:item.visible,enabled:item.enabled,text:item.text||item.label||"",focus:item.activeFocus})
    }
    function state():string {
      var win=fixture.appWindow();var p=fixture.page()
      return JSON.stringify({page:app.page,opened:app.opened,visible:win?win.visible:false,busy:app.setupBusy,
        canLeave:p?p.canLeave:true,signIns:mailService.signIns,cancels:mailService.cancelCalls,
        switched:mailService.accountSwitches,hidden:fakeShell.hidden.length,boundary:fixture.boundary})
    }
    function click(name:string):void { var item=fixture.named(name);if(item) input.mouseClick(item,item.width/2,item.height/2,Qt.LeftButton) }
    function text(name:string,value:string):void { var item=fixture.named(name);if(item) { item.forceActiveFocus();item.text=value } }
    function key(key:int,modifiers:int):void { input.keyClick(key,modifiers) }
    function scroll(bottom:bool):void {
      var p=fixture.named("setup-page")
      while(p) {
        if(p.contentY !== undefined) { p.contentY=bottom ? Math.max(0,p.contentHeight-p.height) : 0;return }
        p=p.parent
      }
    }
    function close():void { app.requestClose() }
    function nativeClose():void { var win=fixture.appWindow();if(win) win.visible=false }
    function reopen():void { app.open("{}") }
    function switchAccount():void { app.switchAccount(1) }
    function event(name:string):void {
      if(name==="tools-start") { fixture.boundary="Package installation";fixture.writeControl({missingTools:["Google Cloud CLI","uv"],action:""}) }
      else if(name==="setup-start") fixture.writeControl({missingTools:[],action:""})
      else if(name==="manual-error") fakeAuth.lastError="Synthetic sign-in failure. Check the client and retry."
      else if(name==="baseline-consent" && fixture.legacy) { fixture.selected();fakeAuth.loginBusy=true;fakeAuth.lastError="" }
      else if(name==="tools-failed") { fixture.boundary="";fixture.writeControl({missingTools:["Google Cloud CLI","uv"],action:"install-fail"}) }
      else if(name==="tools-done") { fixture.boundary="";fixture.writeControl({missingTools:[],action:"install-done"}) }
      else if(name==="browser") { fixture.boundary="Google browser sign-in";fixture.writeControl({missingTools:[],action:"browser"}) }
      else if(name==="provision") { fixture.boundary="";fixture.writeControl({missingTools:[],action:"provision"}) }
      else if(name==="setup-failed") { fixture.boundary="";fixture.writeControl({missingTools:[],action:"setup-fail"}) }
      else if(name==="saved") { fixture.selected();fixture.writeControl({missingTools:[],action:"setup-done"}) }
      else if(name==="consent-failed") { fixture.boundary="";fakeAuth.loginBusy=false;fakeAuth.lastError="Google sign-in was not completed. Retry when you are ready." }
      else if(name==="connected") { fixture.boundary="";fakeAuth.loginBusy=false;fakeAuth.loggedIn=true;fakeAuth.lastError="";mailService.accountEmail="owner@example.com" }
      else if(name==="inbox") { mailService.ready=true;mailService.anyAccountReady=true;mailService.hasSavedAccounts=true }
      else if(name==="backend-wait") fakeBackend.ready=false
      else if(name==="backend-ready") fakeBackend.ready=true
    }
  }
  Rectangle {
    id: evidenceLabel
    visible: Quickshell.env("OMAMAIL_REVIEW_HIDE_CAPTION") !== "1"
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: 54
    z: 9999
    color: Commons.Color.background
    border.color: Commons.Color.accent
    Text {
      anchors.fill: parent
      anchors.margins: 8
      text: "SYNTHETIC SERVICE RESPONSES · " + fixture.caption
      textFormat: Text.PlainText
      color: Commons.Color.foreground
      font.pixelSize: 14
      wrapMode: Text.WordWrap
    }
  }
  TestCase { id:input; name:"ReviewInput"; when:false }
  Timer { interval:500;running:true;onTriggered:fixture.reset("dark",1200,900) }
}
