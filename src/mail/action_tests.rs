use super::action::{ActionLookup, domain_action, dry_run, plan_action};
use super::{Account, ActRequest, Provider};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Default)]
struct Effects {
    refusal_lookup: AtomicUsize,
    lookup: AtomicUsize,
    provider_mutation: AtomicUsize,
    network: AtomicUsize,
    process: AtomicUsize,
    cache_write: AtomicUsize,
    account_write: AtomicUsize,
    outbox: AtomicUsize,
    filesystem_write: AtomicUsize,
}

static SENTINEL_SERIAL: AtomicUsize = AtomicUsize::new(0);

struct RecordingLookup {
    refusals: Value,
    rows: HashMap<String, Value>,
    effects: Arc<Effects>,
}

impl ActionLookup for RecordingLookup {
    fn refusals(&self, _account: &Account) -> Result<Value, &'static str> {
        self.effects.refusal_lookup.fetch_add(1, Ordering::SeqCst);
        Ok(self.refusals.clone())
    }

    fn rows<'a>(
        &'a self,
        _account: &'a Account,
        ids: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Value>, &'static str>> + Send + 'a>> {
        self.effects.lookup.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(ids
                .iter()
                .filter_map(|id| self.rows.get(id).cloned())
                .collect())
        })
    }
}

fn account(provider: Provider) -> Account {
    Account {
        id: format!("{}:me@example.org", provider.id()),
        provider,
    }
}

fn request(provider: Provider, operation: &str, ids: &[&str]) -> ActRequest {
    ActRequest {
        account: account(provider),
        operation: operation.into(),
        ids: ids.iter().map(|id| (*id).into()).collect(),
        execute: false,
    }
}

fn lookup(refusals: Value, rows: &[Value], effects: Arc<Effects>) -> RecordingLookup {
    RecordingLookup {
        refusals,
        rows: rows
            .iter()
            .map(|row| (row["id"].as_str().unwrap().to_owned(), row.clone()))
            .collect(),
        effects,
    }
}

fn row(id: &str) -> Value {
    json!({"id":id})
}

fn sentinel_directory() -> PathBuf {
    let directory = env::temp_dir().join(format!(
        "omamail-action-sentinel-{}-{}",
        std::process::id(),
        SENTINEL_SERIAL.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("unchanged"), "sentinel").unwrap();
    directory
}

#[test]
fn mark_vocabulary_maps_once_to_domain_actions() {
    assert_eq!(domain_action("read"), Ok("markRead"));
    assert_eq!(domain_action("unread"), Ok("markUnread"));
    assert_eq!(domain_action("star"), Ok("star"));
    assert_eq!(domain_action("unstar"), Ok("unstar"));
}

#[tokio::test]
async fn plans_exact_model_label_changes_and_a_dedicated_trash_operation() {
    for (operation, add, remove) in [
        ("read", json!([]), json!(["UNREAD"])),
        ("unread", json!(["UNREAD"]), json!([])),
        ("star", json!(["STARRED"]), json!([])),
        ("unstar", json!([]), json!(["STARRED"])),
        ("archive", json!([]), json!(["INBOX"])),
        ("spam", json!(["SPAM"]), json!(["INBOX"])),
    ] {
        let effects = Arc::new(Effects::default());
        let plan = plan_action(
            &request(Provider::Gmail, operation, &["message-1"]),
            &lookup(Value::Null, &[row("message-1")], effects),
        )
        .await
        .unwrap();
        assert_eq!(plan.operation, operation);
        assert_eq!(json!(plan.add_label_ids), add);
        assert_eq!(json!(plan.remove_label_ids), remove);
    }

    let effects = Arc::new(Effects::default());
    let plan = plan_action(
        &request(Provider::Gmail, "trash", &["message-1"]),
        &lookup(Value::Null, &[row("message-1")], effects),
    )
    .await
    .unwrap();
    assert_eq!(plan.operation, "trash");
    assert_eq!(plan.add_label_ids, ["TRASH"]);
    assert_eq!(plan.remove_label_ids, Vec::<String>::new());
}

#[tokio::test]
async fn conversation_targets_are_deduplicated_in_first_appearance_order() {
    let effects = Arc::new(Effects::default());
    let conversation = json!({
        "id":"conversation-1",
        "thread":{"memberIds":["inbox-1", "sent-1", "inbox-1", "self-1", "excluded-1"]}
    });
    let plan = plan_action(
        &request(Provider::Jmap, "archive", &["conversation-1"]),
        &lookup(Value::Null, &[conversation], effects),
    )
    .await
    .unwrap();
    assert_eq!(
        plan.target_ids,
        ["inbox-1", "sent-1", "self-1", "excluded-1"]
    );
}

#[tokio::test]
async fn capability_ceilings_and_account_refusals_precede_target_lookup() {
    for (provider, operation, refusals) in [
        (Provider::Hey, "archive", Value::Null),
        (Provider::Hey, "star", Value::Null),
        (Provider::Imap, "spam", Value::Null),
        (Provider::Outlook, "spam", Value::Null),
        (
            Provider::Jmap,
            "archive",
            json!({"archive":"No Archive mailbox"}),
        ),
    ] {
        let effects = Arc::new(Effects::default());
        let error = plan_action(
            &request(provider, operation, &["message-1"]),
            &lookup(refusals, &[row("message-1")], effects.clone()),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error, "mail_action_unavailable",
            "{provider:?}: {operation}"
        );
        assert_eq!(effects.lookup.load(Ordering::SeqCst), 0);
    }
    assert!(!crate::providers::can("unknown", "archive", &Value::Null));
}

#[tokio::test]
async fn dry_runs_return_stable_json_without_provider_or_local_side_effects() {
    let effects = Arc::new(Effects::default());
    let directory = sentinel_directory();
    let action = request(Provider::Gmail, "archive", &["message-1"]);
    let action_lookup = lookup(Value::Null, &[row("message-1")], effects.clone());
    let result = dry_run(&action, &action_lookup).await.unwrap();
    assert_eq!(
        result,
        json!({
            "dryRun":true,
            "executed":false,
            "operation":"archive",
            "accountId":"gmail:me@example.org",
            "requestedIds":["message-1"],
            "targetIds":["message-1"]
        })
    );
    for counter in [
        &effects.provider_mutation,
        &effects.network,
        &effects.process,
        &effects.cache_write,
        &effects.account_write,
        &effects.outbox,
        &effects.filesystem_write,
    ] {
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
    assert_eq!(
        fs::read_to_string(directory.join("unchanged")).unwrap(),
        "sentinel"
    );
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn unsafe_or_oversized_ids_fail_before_any_lookup_or_mutation() {
    for id in [
        "line\rbreak",
        "line\nbreak",
        "line\r\nbreak",
        "nul\0byte",
        "bidi\u{202e}override",
        &"x".repeat(8193),
    ] {
        let effects = Arc::new(Effects::default());
        let error = plan_action(
            &request(Provider::Gmail, "archive", &[id]),
            &lookup(Value::Null, &[row("message-1")], effects.clone()),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "invalid_params");
        assert_eq!(effects.refusal_lookup.load(Ordering::SeqCst), 0);
        assert_eq!(effects.lookup.load(Ordering::SeqCst), 0);
        assert_eq!(effects.provider_mutation.load(Ordering::SeqCst), 0);
    }

    let effects = Arc::new(Effects::default());
    let plan = plan_action(
        &request(Provider::Gmail, "archive", &["quote\"slash\\"]),
        &lookup(Value::Null, &[row("quote\"slash\\")], effects.clone()),
    )
    .await
    .unwrap();
    assert_eq!(plan.target_ids, ["quote\"slash\\"]);
    assert_eq!(effects.provider_mutation.load(Ordering::SeqCst), 0);
}
