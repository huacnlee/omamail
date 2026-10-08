use super::action::{ActionMutation, ActionPlan};
use super::action_tests::{Effects, lookup, row};
use super::clear_unread::{STEP_SIZE, step};
use super::list::ListAdapter;
use super::{Account, ClearUnreadRequest, ListRequest, Provider};
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

impl ListAdapter for UnreadPage {
    fn list<'a>(
        &'a self,
        request: &'a ListRequest,
        provider_query: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        self.seen.lock().unwrap().push(json!({
            "query": provider_query,
            "limit": request.limit,
            "pageToken": request.page_token,
        }));
        Box::pin(async move {
            Ok(json!({
                "ids": self.ids,
                "messages": self.ids.iter().map(|id| json!({"id":id})).collect::<Vec<_>>(),
                "nextPageToken": "",
                "estimate": self.ids.len(),
            }))
        })
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
    let unread = crate::providers::domain::resolve(&json!({
        "operation":"query",
        "provider":"jmap",
        "mailbox":crate::providers::domain::query_mailbox("jmap", "unread").unwrap(),
        "search":"",
    }))
    .unwrap()["value"]
        .clone();
    assert_eq!(STEP_SIZE, 100);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![json!({"query":unread,"limit":100,"pageToken":""})]
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
