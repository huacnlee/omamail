use super::action::{ActionAvailability, ActionLookup, domain_action, plan_action};
use super::{Account, ActRequest, Provider};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
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
}

struct RecordingLookup {
    availability: ActionAvailability,
    rows: HashMap<String, Value>,
    effects: Arc<Effects>,
}

impl ActionLookup for RecordingLookup {
    fn availability<'a>(
        &'a self,
        _account: &'a Account,
    ) -> Pin<Box<dyn Future<Output = Result<ActionAvailability, &'static str>> + Send + 'a>> {
        self.effects.refusal_lookup.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(self.availability.clone()) })
    }

    fn rows<'a>(
        &'a self,
        _account: &'a Account,
        ids: &'a [String],
        _availability: &'a ActionAvailability,
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
    lookup_with_mailboxes(
        refusals,
        json!({"archive":true,"trash":true,"spam":true}),
        rows,
        effects,
    )
}

fn lookup_with_mailboxes(
    refusals: Value,
    mailboxes: Value,
    rows: &[Value],
    effects: Arc<Effects>,
) -> RecordingLookup {
    RecordingLookup {
        availability: ActionAvailability {
            refusals,
            mailboxes,
            mailbox_required: Value::Null,
            rows_context: Value::Null,
        },
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
async fn malformed_conversation_members_are_rejected_before_any_coercion_or_trim() {
    for members in [
        json!(["safe", "bad\n"]),
        json!(["safe", 7]),
        json!(["safe", null]),
    ] {
        let effects = Arc::new(Effects::default());
        let conversation = json!({"id":"conversation-1","thread":{"memberIds":members}});
        let error = plan_action(
            &request(Provider::Jmap, "archive", &["conversation-1"]),
            &lookup(Value::Null, &[conversation], effects),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "mail_action_invalid_target");
    }
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
async fn dynamic_destination_availability_refuses_before_target_lookup() {
    let effects = Arc::new(Effects::default());
    let error = plan_action(
        &request(Provider::Jmap, "archive", &["message-1"]),
        &lookup_with_mailboxes(
            Value::Null,
            json!({"archive":false,"trash":true,"spam":true}),
            &[row("message-1")],
            effects.clone(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_action_destination_unavailable");
    assert_eq!(effects.lookup.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn hey_spam_is_a_direct_provider_action_not_a_listable_mailbox_move() {
    let effects = Arc::new(Effects::default());
    let planner = lookup_with_mailboxes(
        Value::Null,
        json!({"archive":false,"trash":true,"spam":false}),
        &[row("message-1")],
        effects,
    );
    let mut availability = planner.availability.clone();
    availability.mailbox_required = json!({"spam":false});
    let planner = RecordingLookup {
        availability,
        ..planner
    };
    assert_eq!(
        plan_action(&request(Provider::Hey, "spam", &["message-1"]), &planner)
            .await
            .unwrap()
            .target_ids,
        ["message-1"]
    );
}

#[tokio::test]
async fn duplicate_requested_ids_are_deduplicated_before_provider_lookup() {
    let effects = Arc::new(Effects::default());
    let plan = plan_action(
        &request(Provider::Jmap, "archive", &["one", "one", "two", "one"]),
        &lookup(Value::Null, &[row("one"), row("two")], effects.clone()),
    )
    .await
    .unwrap();
    assert_eq!(plan.target_ids, ["one", "two"]);
    assert_eq!(effects.lookup.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn aggregate_conversation_expansion_is_bounded_before_a_preview_is_retained() {
    let effects = Arc::new(Effects::default());
    let members = (0..2001)
        .map(|n| json!(format!("m{n}")))
        .collect::<Vec<_>>();
    let oversized = json!({"id":"one","thread":{"memberIds":members}});
    assert_eq!(
        plan_action(
            &request(Provider::Jmap, "archive", &["one"]),
            &lookup(Value::Null, &[oversized], effects),
        )
        .await
        .unwrap_err(),
        "mail_action_target_limit"
    );
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
    }

    let effects = Arc::new(Effects::default());
    let plan = plan_action(
        &request(Provider::Gmail, "archive", &["quote\"slash\\"]),
        &lookup(Value::Null, &[row("quote\"slash\\")], effects.clone()),
    )
    .await
    .unwrap();
    assert_eq!(plan.target_ids, ["quote\"slash\\"]);
}

#[tokio::test]
async fn execute_is_refused_before_availability_or_provider_mutation() {
    let effects = Arc::new(Effects::default());
    let mut action = request(Provider::Gmail, "archive", &["message-1"]);
    action.execute = true;
    let error = plan_action(
        &action,
        &lookup(Value::Null, &[row("message-1")], effects.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mail_action_execute_unsupported");
    assert_eq!(effects.refusal_lookup.load(Ordering::SeqCst), 0);
    assert_eq!(effects.lookup.load(Ordering::SeqCst), 0);
}
