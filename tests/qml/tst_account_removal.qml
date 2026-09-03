import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Accounts.js" as Accounts

// Which mailbox the setup page is actually working on.
//
// `activeId` names the mailbox on screen; `activeIndex` overrides it for a row
// that has no id yet, because a draft cannot be named. Add account leaves both
// set — the draft at `activeIndex`, the previous mailbox still at `activeId` —
// and every reader has to agree on which one wins. Remove account did not: it
// asked `indexOfActiveAccount()` alone, so on the page of a freshly added
// mailbox it named the mailbox that was there before, and confirming deleted a
// working account while the page in front of the user showed an empty form.
//
// The list is assigned rather than fed through `applyAccounts`, so no test
// depends on the file watcher or on the state a previous test left the writer
// in.
Item {
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(id, entry) {}
    function hide(id) {}
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App { id: app; service: mailService }

  TestCase {
    name: "AccountRemoval"
    when: windowShown

    readonly property string ada: "ada@example.com"
    readonly property string bob: "bob@example.com"
    readonly property string adaId: "imap:ada@example.com"
    readonly property string bobId: "imap:bob@example.com"

    function entry(email) {
      return { email: email, provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com",
                smtpPort: 465, username: email, aliases: [], insecure: false },
        label: "", signature: "" }
    }

    function seed(emails, activeId) {
      var list = Accounts.emptyList()
      for (var i = 0; i < emails.length; i++) list = Accounts.add(list, entry(emails[i]))
      list = Accounts.setActive(list, activeId)
      mailService.activeIndex = -1
      mailService.accountList = list
      mailService.accountsLoaded = true
      mailService.refreshCurrent()
    }

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function dialog() {
      var found = named(app, "")
      // The dialog carries the request it was opened for; find it by shape,
      // since it has no object name of its own.
      function walk(item) {
        if (!item) return null
        if (item.hasOwnProperty("request") && item.hasOwnProperty("opened")
            && String(item).indexOf("AccountRemovalDialog") === 0) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) {
          var f = walk(kids[i])
          if (f) return f
        }
        return null
      }
      return walk(app)
    }

    function emails() {
      var out = []
      var values = mailService.accountSummaries || []
      for (var i = 0; i < values.length; i++) out.push(values[i].email)
      return out
    }

    // The bug this file exists for.
    function test_remove_on_a_new_mailbox_page_spares_the_mailbox_behind_it() {
      seed([ada], adaId)
      app.chooseProvider("imap")           // Add a mailbox... -> IMAP
      compare(mailService.accountCount, 2)
      compare(mailService.editingIndex(), 1, "the page is editing the new row")

      app.removeCurrentAccountFromEditor()

      compare(dialog().request, null,
        "a draft has no mailbox to name, so nothing is offered for confirmation")
      compare(emails(), [ada], "the mailbox that was there before is untouched")
      compare(mailService.accountCount, 1, "the draft is discarded instead")
    }

    // The same divergence, reached the other way: `switchToIndex` used to
    // return early without clearing `activeIndex`, so Edit opened whatever
    // draft happened to be open rather than the mailbox that was clicked.
    function test_edit_opens_the_mailbox_that_was_clicked_not_an_open_draft() {
      seed([ada, bob], adaId)
      app.chooseProvider("imap")           // draft is row 2
      compare(mailService.editingIndex(), 2)

      app.editAccount(0)
      compare(mailService.editingIndex(), 0)
      compare(mailService.accountAddress, ada, "the editor opens on ada")

      app.editAccount(1)
      compare(mailService.editingIndex(), 1)
      compare(mailService.accountAddress, bob, "and on bob")
    }

    function test_remove_on_a_real_mailbox_names_that_mailbox() {
      seed([ada, bob], adaId)
      app.editAccount(1)
      app.removeCurrentAccountFromEditor()

      var request = dialog().request
      verify(request !== null, "a mailbox can be removed")
      compare(request.email, bob, "and the confirmation names the one on screen")
      compare(request.index, 1)

      app.confirmAccountRemoval(request)
      compare(emails(), [ada])
    }

    // An address that is not an address derives no account id, which leaves a
    // row that reads as saved and behaves like a draft: unselectable,
    // uneditable and unremovable. `validateSettings` cannot catch it —
    // `setupSettings` folds the address into `username` and passes no address
    // on — so the form refuses it.
    function test_the_imap_form_refuses_an_address_that_is_not_one() {
      seed([ada], adaId)
      app.chooseProvider("imap")
      var page = named(app, "setup-page")
      verify(page !== null && page.item !== null, "the IMAP setup page is up")

      var field = named(page.item, "imap-address-field")
      var error = named(page.item, "imap-error")
      verify(field !== null && error !== null)

      // The message has to be the address's own. Without the check the server
      // fields — which a junk address cannot fill in either — reject the form
      // one field later, so "something was refused" would pass either way and
      // test nothing.
      field.text = "ada"
      page.item.save()
      compare(mailService.accountSummaries[1].email, "", "nothing was saved")
      compare(error.text, "That is not a full email address")

      field.text = ""
      page.item.save()
      compare(mailService.accountSummaries[1].email, "")
      compare(error.text, "Add the email address for this mailbox")

      field.text = "carol@example.com"
      page.item.save()
      compare(mailService.accountSummaries[1].email, "carol@example.com",
        "a real address goes through")
      compare(mailService.accountSummaries[1].id, "imap:carol@example.com")
    }

    // The form is not the only way an address reaches the list: an account
    // reports its own on its first profile read. A provider that answers with
    // something that is not an address — an IMAP username, say — must not be
    // able to rename a working mailbox into one that addresses nothing.
    function test_a_profile_cannot_rename_a_mailbox_to_a_non_address() {
      seed([ada], adaId)
      mailService.nameAccount(0, "ada")
      compare(mailService.accountSummaries[0].email, ada, "the address is kept")
      compare(mailService.accountSummaries[0].id, adaId, "and so is the id")

      // A real address still renames.
      mailService.nameAccount(0, "carol@example.com")
      compare(mailService.accountSummaries[0].id, "imap:carol@example.com")
    }

    // `accountAddress` is a binding that now reaches `activeIndex` through a
    // function call. QML captures property reads made inside the callee, so it
    // still re-evaluates — but silently going stale here would put the wrong
    // mailbox in the editor, so it is pinned down rather than assumed.
    function test_the_address_binding_still_tracks_activeIndex_alone() {
      seed([ada, bob], adaId)
      compare(mailService.accountAddress, ada)
      mailService.activeIndex = 1
      compare(mailService.accountAddress, bob, "the binding re-evaluates")
      mailService.activeIndex = 0
      compare(mailService.accountAddress, ada)
      mailService.activeIndex = -1
      compare(mailService.accountAddress, ada)
    }

    // A draft is the form's working state. It used to ride along on whatever
    // save happened next, leaving a "New mailbox" on disk that nothing could
    // select and nothing could remove.
    function test_a_draft_is_never_part_of_what_is_written() {
      seed([ada], adaId)
      app.chooseProvider("imap")
      compare(mailService.accountCount, 2)

      // Something unrelated to the draft saves the list.
      mailService.accountsWritePayload = ""
      mailService.setAccountSignature(adaId, "signed")
      verify(mailService.accountsWritePayload !== "", "the list was written")

      var written = Accounts.load(mailService.accountsWritePayload)
      compare(Accounts.count(written), 1, "only the mailbox is written")
      compare(written.accounts[0].email, ada)
      compare(written.activeId, adaId, "and it is still the selected one")
      compare(mailService.accountCount, 2, "the draft stays in memory for the form")
    }
  }
}
