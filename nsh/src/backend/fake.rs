//! A backend in memory: the handshake, accounts, mailboxes and messages of
//! a made-up account, for tests, screenshots and demos.

use std::{cell::RefCell, collections::VecDeque, rc::Rc, task::Waker};

use serde_json::{Value, json};

use super::{Backend, Event, NextEvent, Reply, wire::RpcError};

#[derive(Default)]
struct State {
    calls: Vec<(String, Value)>,
    events: VecDeque<Event>,
    waker: Option<Waker>,
}

/// A [`Backend`] answering from canned data, at once.
#[derive(Clone)]
pub struct FakeBackend {
    info: Value,
    accounts: Value,
    messages: Value,
    bodies: Rc<Vec<(String, String)>>,
    state: Rc<RefCell<State>>,
}

/// A message of the sample account.
struct Sample {
    id: &'static str,
    from: &'static str,
    subject: &'static str,
    snippet: &'static str,
    time: &'static str,
    unread: bool,
    html: &'static str,
}

const SAMPLE: &[Sample] = &[
    Sample {
        id: "m1",
        from: "Mira Chen",
        subject: "Design review notes",
        snippet: "Thanks for the walkthrough. A few notes on the reader before Friday.",
        time: "09:41",
        unread: true,
        html: "<p>Hi,</p><p>Thanks for the walkthrough. A few notes on the reader before Friday:</p>\
         <ul><li>Keep the <strong>sender row</strong> compact.</li><li>Links open in the browser.</li></ul>\
         <p>See the <a href=\"https://example.com/spec\">spec</a> for details.</p><p>Mira</p>",
    },
    Sample {
        id: "m2",
        from: "GitHub",
        subject: "[omamail] CI passed on main",
        snippet: "All checks have passed for the latest commit.",
        time: "08:12",
        unread: true,
        html: "<p>All checks have passed for <code>9610347</code>.</p><blockquote><p>Release v0.12.0</p></blockquote>",
    },
    Sample {
        id: "m3",
        from: "李雷",
        subject: "周五的发布安排",
        snippet: "发布前请再确认一次日历同步。",
        time: "Yesterday",
        unread: false,
        html: "<p>你好，</p><p>发布前请再确认一次日历同步，谢谢。</p>",
    },
    Sample {
        id: "m4",
        from: "Billing",
        subject: "Your invoice for November",
        snippet: "Invoice #2026-11 is ready.",
        time: "Nov 24",
        unread: false,
        html: "<h2>Invoice #2026-11</h2><table><tr><td>Service</td><td>$12.00</td></tr></table>",
    },
];

impl FakeBackend {
    /// One account with a short inbox, speaking the compiled API version.
    pub fn sample() -> Self {
        let pins = super::Pins::compiled();
        let messages: Vec<Value> = SAMPLE
            .iter()
            .map(|m| {
                json!({"id": m.id, "threadId": m.id, "from": {"name": m.from, "email": format!("{}@example.org", m.id)},
                       "subject": m.subject, "snippet": m.snippet, "time": m.time, "unread": m.unread, "starred": false})
            })
            .collect();
        Self {
            info: json!({"version": pins.version, "protocol": 1, "apiVersion": pins.api_version,
                         "methods": ["system.info", "accounts.list", "mail.list", "mail.watch", "reader.open", "reader.render"],
                         "capabilities": {}}),
            accounts: json!({"accounts": [{"id": "gmail:ada@example.org", "email": "ada@example.org", "provider": "gmail",
                                           "label": "Ada", "pending": false}],
                             "activeId": "gmail:ada@example.org"}),
            messages: Value::Array(messages),
            bodies: Rc::new(
                SAMPLE
                    .iter()
                    .map(|m| (m.0.to_owned(), m.6.to_owned()))
                    .collect(),
            ),
            state: Rc::default(),
        }
    }

    /// The same backend answering `system.info` with `info`.
    pub fn with_info(mut self, info: Value) -> Self {
        self.info = info;
        self
    }

    /// The calls made so far, in order.
    pub fn calls(&self) -> Vec<(String, Value)> {
        self.state.borrow().calls.clone()
    }

    /// Pushes `event` as if the backend had sent it.
    pub fn emit(&self, method: &str, params: Value) {
        let mut state = self.state.borrow_mut();
        state.events.push_back(Event {
            method: method.to_owned(),
            params,
        });
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
    }

    fn answer(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            "system.info" => Ok(self.info.clone()),
            "accounts.list" => Ok(self.accounts.clone()),
            "mail.watch" | "mail.unwatch" | "reader.cancel" => Ok(json!({})),
            "mail.list" => {
                let mailbox = params["mailbox"].as_str().unwrap_or("inbox");
                let all = self.messages.as_array().cloned().unwrap_or_default();
                let messages: Vec<Value> = match mailbox {
                    "inbox" => all,
                    "unread" => all.into_iter().filter(|m| m["unread"] == true).collect(),
                    "starred" => all.into_iter().filter(|m| m["starred"] == true).collect(),
                    _ => Vec::new(),
                };
                Ok(
                    json!({"accountId": self.accounts["activeId"], "mailbox": mailbox, "messages": messages,
                          "nextPageToken": "", "estimate": messages.len()}),
                )
            }
            "reader.open" | "reader.render" => {
                let id = params["id"].as_str().unwrap_or_default();
                let html = self
                    .bodies
                    .iter()
                    .find(|(m, _)| m == id)
                    .map(|(_, html)| html.clone())
                    .ok_or_else(|| RpcError::new(-32000, "reader_message_missing"))?;
                let summary = self
                    .messages
                    .as_array()
                    .and_then(|m| m.iter().find(|m| m["id"] == id))
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(
                    json!({"id": id, "nativeSummary": summary, "readerKey": format!("fake:{id}"),
                          "nativeRender": {"revision": id, "reader": {"document": parse_simple(&html), "empty": false}}}),
                )
            }
            _ => Err(RpcError::new(-32601, "Method not found")),
        }
    }
}

impl Backend for FakeBackend {
    fn call(&self, method: &str, params: Value) -> Reply {
        self.state
            .borrow_mut()
            .calls
            .push((method.to_owned(), params.clone()));
        let result = self.answer(method, &params);
        Box::pin(async move { result })
    }

    fn next_event(&self) -> NextEvent {
        let state = self.state.clone();
        Box::pin(std::future::poll_fn(move |cx| {
            let mut state = state.borrow_mut();
            match state.events.pop_front() {
                Some(event) => std::task::Poll::Ready(Some(event)),
                None => {
                    state.waker = Some(cx.waker().clone());
                    std::task::Poll::Pending
                }
            }
        }))
    }
}

/// The backend's document tree (`message::html::tree::Node` serialized)
/// for the well-formed sample HTML above: elements, attributes in double
/// quotes and text, no entities.
fn parse_simple(html: &str) -> Value {
    fn element(name: &str, attrs: Vec<Value>) -> Value {
        json!({"type": "element", "name": name, "attrs": attrs, "selfClosing": false, "children": []})
    }
    let mut stack = vec![json!({"type": "root", "children": []})];
    let mut rest = html;
    while !rest.is_empty() {
        if let Some(tail) = rest.strip_prefix("</") {
            let end = tail.find('>').unwrap_or(tail.len());
            rest = &tail[(end + 1).min(tail.len())..];
            if stack.len() > 1 {
                let node = stack.pop().expect("an open element");
                push_child(stack.last_mut().expect("the root"), node);
            }
        } else if let Some(tail) = rest.strip_prefix('<') {
            let end = tail.find('>').unwrap_or(tail.len());
            let tag = &tail[..end];
            rest = &tail[(end + 1).min(tail.len())..];
            let mut parts = tag.splitn(2, ' ');
            let name = parts.next().unwrap_or_default().to_ascii_lowercase();
            let mut attrs = Vec::new();
            if let Some(list) = parts.next() {
                for attr in list.split("\" ") {
                    if let Some((key, value)) = attr.split_once("=\"") {
                        attrs.push(
                            json!({"name": key.trim(), "value": value.trim_end_matches('"')}),
                        );
                    }
                }
            }
            stack.push(element(&name, attrs));
        } else {
            let end = rest.find('<').unwrap_or(rest.len());
            let text = &rest[..end];
            rest = &rest[end..];
            push_child(
                stack.last_mut().expect("the root"),
                json!({"type": "text", "text": text}),
            );
        }
    }
    while stack.len() > 1 {
        let node = stack.pop().expect("an open element");
        push_child(stack.last_mut().expect("the root"), node);
    }
    stack.pop().expect("the root")
}

fn push_child(parent: &mut Value, child: Value) {
    if let Some(children) = parent["children"].as_array_mut() {
        children.push(child);
    }
}
