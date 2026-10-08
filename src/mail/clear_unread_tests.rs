use super::action::{ActionMutation, ActionPlan};
use super::action_tests::{Effects, lookup, row};
use super::clear_unread::{STEP_SIZE, UnreadIds, step};
use super::{Account, ClearUnreadRequest, Mailbox, Provider};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

const ACCOUNT: &str = "jmap:me@example.org";

struct UnreadPage {
    ids: Vec<&'static str>,
    seen: Arc<Mutex<Vec<Value>>>,
}

impl UnreadIds for UnreadPage {
    fn unread_ids<'a>(
        &'a self,
        account: &'a Account,
        provider_query: String,
        limit: u16,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, &'static str>> + Send + 'a>> {
        self.seen.lock().unwrap().push(json!({
            "account": account.id,
            "query": provider_query,
            "limit": limit,
        }));
        Box::pin(async move { Ok(self.ids.iter().map(|id| (*id).to_owned()).collect()) })
    }
}

/// Confirms only the targets it was told to, the way a provider acknowledges
/// part of a batch.
#[derive(Default)]
struct PartialMutation {
    confirms: Vec<&'static str>,
    calls: AtomicUsize,
    plans: Mutex<Vec<(String, Vec<String>)>>,
}

impl ActionMutation for PartialMutation {
    fn execute<'a>(
        &'a self,
        plan: &'a ActionPlan,
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.plans
            .lock()
            .unwrap()
            .push((plan.operation.clone(), plan.target_ids.clone()));
        Box::pin(async move {
            plan.target_ids
                .iter()
                .filter(|id| self.confirms.contains(&id.as_str()))
                .cloned()
                .collect()
        })
    }
}

fn request(execute: bool) -> ClearUnreadRequest {
    ClearUnreadRequest {
        account: Account {
            id: ACCOUNT.into(),
            provider: Provider::Jmap,
        },
        execute,
    }
}

fn page(ids: &[&'static str]) -> (UnreadPage, Arc<Mutex<Vec<Value>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    (
        UnreadPage {
            ids: ids.to_vec(),
            seen: seen.clone(),
        },
        seen,
    )
}

fn rows(ids: &[&str]) -> Vec<Value> {
    ids.iter().map(|id| row(id)).collect()
}

#[tokio::test]
async fn lists_unread_from_the_top_in_steps_of_100() {
    let (list, seen) = page(&["e1"]);
    let effects = Arc::new(Effects::default());
    let mutation = PartialMutation {
        confirms: vec!["e1"],
        ..Default::default()
    };
    step(
        &request(true),
        &list,
        &lookup(json!({}), &rows(&["e1"]), effects),
        &mutation,
    )
    .await
    .unwrap();
    let unread = super::list::provider_query(&request(true).account, Mailbox::Unread, "").unwrap();
    assert!(unread.contains("unseen"), "{unread}");
    assert_eq!(STEP_SIZE, 100);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![json!({"account":ACCOUNT,"query":unread,"limit":100})]
    );
}

#[tokio::test]
async fn marks_listed_ids_and_reports_progress() {
    let (list, _) = page(&["e1", "e2"]);
    let effects = Arc::new(Effects::default());
    let mutation = PartialMutation {
        confirms: vec!["e1", "e2"],
        ..Default::default()
    };
    let result = step(
        &request(true),
        &list,
        &lookup(json!({}), &rows(&["e1", "e2"]), effects),
        &mutation,
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"done":false,"marked":2,"failed":0}));
    assert_eq!(
        *mutation.plans.lock().unwrap(),
        vec![("read".to_owned(), vec!["e1".to_owned(), "e2".to_owned()])]
    );
}

#[tokio::test]
async fn reports_done_when_unread_is_empty() {
    let (list, _) = page(&[]);
    let effects = Arc::new(Effects::default());
    let mutation = PartialMutation::default();
    let result = step(
        &request(true),
        &list,
        &lookup(json!({}), &[], effects.clone()),
        &mutation,
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"done":true,"marked":0,"failed":0}));
    assert_eq!(effects.lookup.load(Ordering::SeqCst), 0);
    assert_eq!(mutation.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn dry_run_changes_nothing() {
    let (list, _) = page(&["e1"]);
    let effects = Arc::new(Effects::default());
    let mutation = PartialMutation {
        confirms: vec!["e1"],
        ..Default::default()
    };
    let result = step(
        &request(false),
        &list,
        &lookup(json!({}), &rows(&["e1"]), effects),
        &mutation,
    )
    .await
    .unwrap();
    assert_eq!(result["dryRun"], true);
    assert_eq!(result["done"], false);
    assert_eq!(result["targetIds"], json!(["e1"]));
    assert_eq!(mutation.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn counts_failed_targets() {
    let (list, _) = page(&["e1", "e2"]);
    let effects = Arc::new(Effects::default());
    let mutation = PartialMutation {
        confirms: vec!["e1"],
        ..Default::default()
    };
    let result = step(
        &request(true),
        &list,
        &lookup(json!({}), &rows(&["e1", "e2"]), effects),
        &mutation,
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"done":false,"marked":1,"failed":1}));
}

#[tokio::test]
async fn stops_when_nothing_was_marked() {
    let (list, _) = page(&["e1", "e2"]);
    let effects = Arc::new(Effects::default());
    let mutation = PartialMutation::default();
    let result = step(
        &request(true),
        &list,
        &lookup(json!({}), &rows(&["e1", "e2"]), effects),
        &mutation,
    )
    .await;
    assert_eq!(result, Err("mail_clear_unread_stalled"));
}

#[tokio::test]
async fn a_conversation_past_the_target_limit_stops_the_step() {
    // JMAP lists one row per conversation, and reading marks the whole one.
    let (list, _) = page(&["e1"]);
    let members: Vec<String> = (0..2_001).map(|n| format!("m{n}")).collect();
    let effects = Arc::new(Effects::default());
    let mutation = PartialMutation::default();
    let result = step(
        &request(true),
        &list,
        &lookup(
            json!({}),
            &[json!({"id":"e1","thread":{"id":"t1","memberIds":members}})],
            effects,
        ),
        &mutation,
    )
    .await;
    assert_eq!(result, Err("mail_action_target_limit"));
    assert_eq!(mutation.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn request_accepts_only_account_and_execute() {
    for params in [
        json!({"account":ACCOUNT,"ids":["e1"]}),
        json!({"account":ACCOUNT,"execute":"yes"}),
    ] {
        assert!(matches!(
            ClearUnreadRequest::try_from(&params),
            Err("invalid_params")
        ));
    }
}
