import QtQuick
import QtTest
import "../.." as Omamail
import "../../account/Accounts.js" as Accounts

Item {
  width: 600
  height: 400
  QtObject {
    id: store
    function updateEntryInline(id, entry) {
    }
  }
  Component {
    id: serviceComponent
    Omamail.Service {
      shell: store
      manifest: ({
          id: "omamail",
          __sourceDir: "/tmp/synthetic"
        })
      property int passwordCalls: 0
      property int oauthCalls: 0
      function signInWithPassword(secret) {
        passwordCalls++;
      }
      function signIn() {
        oauthCalls++;
      }
    }
  }
  TestCase {
    name: "AccountPersistence"
    when: windowShown
    function create() {
      var svc = createTemporaryObject(serviceComponent, parent);
      verify(svc !== null);
      var list = Accounts.emptyList();
      list = Accounts.add(list, {
        provider: "gmail",
        email: "alias@example.com"
      });
      list = Accounts.add(list, {
        provider: "gmail",
        email: "other@example.com"
      });
      svc.applyAccounts(Accounts.serialize(list));
      compare(svc.lastPersistedIds.length, 2);
      return svc;
    }
    function writer(svc) {
      for (var i = 0; i < svc.children.length; i++) {
        var child = svc.children[i];
        if (child.command && child.command.indexOf("accounts.json") >= 0)
          return child;
      }
      return null;
    }
    function finishWrite(svc) {
      var process = writer(svc);
      verify(process !== null);
      process.running = false;
      process.exited(0);
    }
    function test_queued_profile_correction_is_saved_after_the_old_write() {
      var svc = create();
      svc.saveAccounts();
      svc.nameAccount(0, "canonical@example.com");
      compare(svc.accountsSaveQueued, true);
      finishWrite(svc);
      verify(svc.accountsWritePayload.indexOf("canonical@example.com") >= 0);
      verify(svc.accountsWritePayload.indexOf("other@example.com") >= 0);
    }
    function test_profile_duplicate_releases_only_its_redundant_row() {
      var svc = create();
      svc.nameAccount(0, "other@example.com");
      compare(svc.accountList.accounts.length, 1);
      compare(Accounts.load(svc.accountsWritePayload).accounts[0].email, "other@example.com");
    }
    function test_first_profile_name_keeps_existing_accounts() {
      var svc = create();
      svc.accountList = Accounts.add(svc.accountList, {
        provider: "gmail",
        email: "",
        pending: true
      });
      svc.nameAccount(2, "new@example.com");
      compare(Accounts.load(svc.accountsWritePayload).accounts.length, 3);
    }
    function test_invalid_profile_name_changes_nothing() {
      var svc = create();
      var before = Accounts.serialize(svc.accountList);
      svc.nameAccount(0, "");
      compare(Accounts.serialize(svc.accountList), before);
      compare(svc.lastPersistedIds, ["alias@example.com", "other@example.com"]);
      compare(svc.accountsWritePayload, "");
    }
    function test_correction_does_not_authorize_an_unrelated_drop() {
      var svc = create();
      svc.nameAccount(0, "canonical@example.com");
      finishWrite(svc);
      svc.accountList = Accounts.remove(svc.accountList, "other@example.com");
      svc.saveAccounts();
      compare(writer(svc).running, false, "unrelated omission must not start a writer");
      compare(svc.accountsWritePayload, "");
    }
    function test_provider_identity_change_can_be_saved() {
      var svc = create();
      svc.nameAccount(0, "canonical@example.com");
      compare(svc.accountList.accounts[0].email, "canonical@example.com");
      verify(svc.accountsWritePayload.indexOf("canonical@example.com") >= 0, "profile identity must reach writer");
      finishWrite(svc);
      svc.setAccountLabel("canonical@example.com", "Personal");
      verify(svc.accountsWritePayload.indexOf("Personal") >= 0, "later settings remain writable");
    }
    function test_collision_does_not_dispatch_password_or_oauth() {
      var svc = create();
      var before = Accounts.serialize(svc.accountList);
      compare(svc.configureCurrentAccountAndSignIn({
        email: "other@example.com"
      }, "SYNTHETIC"), false);
      compare(svc.configureCurrentAccountAndSignInOAuth({
        email: "other@example.com"
      }), false);
      wait(0);
      compare(svc.passwordCalls, 0);
      compare(svc.oauthCalls, 0);
      compare(svc.accountsWritePayload, "");
      compare(Accounts.serialize(svc.accountList), before);
    }
  }
}
