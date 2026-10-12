//! Response XML as a small tree. quick-xml tokenizes; this adds the limits a hostile server calls
//! for: a DOCTYPE is refused (so no entity table exists), depth is bounded, elements and their
//! attributes share one budget, and only predefined entities and character references decode. Elements are matched by local
//! name: EWS never reuses one under a different namespace in the places that are read.

use quick_xml::{Reader, escape::resolve_xml_entity, events::BytesStart, events::Event};

const MAX_DEPTH: usize = 32;
const MAX_ELEMENTS: usize = 200_000;
/// More than any EWS element carries.
const MAX_ATTRIBUTES: usize = 64;
const INVALID: &str = "exchange_invalid_response";

#[derive(Default)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub text: String,
    pub children: Vec<Node>,
}

impl Node {
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|child| child.name == name)
    }

    pub fn children(&self, name: &str) -> Vec<&Node> {
        self.children
            .iter()
            .filter(|child| child.name == name)
            .collect()
    }

    /// The descendant reached by the first child of each name in turn.
    pub fn at(&self, path: &[&str]) -> Option<&Node> {
        path.iter().try_fold(self, |node, name| node.child(name))
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        let (_, value) = self.attrs.iter().find(|(key, _)| key == name)?;
        Some(value)
    }

    pub fn text_at(&self, path: &[&str]) -> Option<&str> {
        Some(self.at(path)?.text.trim())
    }
}

/// One element and its attributes, each counted against `budget`. quick-xml's duplicate check is
/// off: it compares every attribute with every other, which a server could make quadratic.
fn start(event: &BytesStart<'_>, budget: &mut usize) -> Result<Node, &'static str> {
    let local = event.local_name();
    let mut node = Node {
        name: std::str::from_utf8(local.as_ref())
            .map_err(|_| INVALID)?
            .to_owned(),
        ..Node::default()
    };
    let mut attributes = event.attributes();
    attributes.with_checks(false);
    for (at, attribute) in attributes.enumerate() {
        *budget += 1;
        if at >= MAX_ATTRIBUTES || *budget > MAX_ELEMENTS {
            return Err(INVALID);
        }
        let attribute = attribute.map_err(|_| INVALID)?;
        let local = attribute.key.local_name();
        let key = std::str::from_utf8(local.as_ref())
            .map_err(|_| INVALID)?
            .to_owned();
        if attribute.key.as_ref().starts_with(b"xmlns") {
            continue;
        }
        let value = attribute.unescape_value().map_err(|_| INVALID)?;
        node.attrs.push((key, value.into_owned()));
    }
    Ok(node)
}

/// A character reference to something XML 1.0 cannot carry (`&#x1;`, a lone surrogate) is how
/// Exchange writes such a property value: it reads as U+FFFD instead of failing the listing.
fn reference(
    text: &mut String,
    reference: &quick_xml::events::BytesRef<'_>,
) -> Result<(), &'static str> {
    if reference.is_char_ref() {
        let legal = |c: char| matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..);
        let c = reference
            .resolve_char_ref()
            .ok()
            .flatten()
            .filter(|c| legal(*c));
        text.push(c.unwrap_or('\u{FFFD}'));
        return Ok(());
    }
    let name = reference.decode().map_err(|_| INVALID)?;
    text.push_str(resolve_xml_entity(&name).ok_or(INVALID)?);
    Ok(())
}

pub fn parse(bytes: &[u8]) -> Result<Node, &'static str> {
    let mut reader = Reader::from_reader(bytes);
    let mut stack: Vec<Node> = Vec::new();
    let mut root = None;
    let mut elements = 0;
    loop {
        match reader.read_event().map_err(|_| INVALID)? {
            event @ (Event::Start(_) | Event::Empty(_)) => {
                let empty = matches!(event, Event::Empty(_));
                let (Event::Start(e) | Event::Empty(e)) = event else {
                    unreachable!()
                };
                elements += 1;
                if stack.len() >= MAX_DEPTH || elements > MAX_ELEMENTS || root.is_some() {
                    return Err(INVALID);
                }
                let node = start(&e, &mut elements)?;
                if !empty {
                    stack.push(node);
                } else if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else {
                    root = Some(node);
                }
            }
            Event::End(_) => {
                let node = stack.pop().ok_or(INVALID)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            Event::Text(t) => {
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&t.xml10_content().map_err(|_| INVALID)?);
                }
            }
            Event::CData(c) => {
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&c.decode().map_err(|_| INVALID)?);
                }
            }
            Event::GeneralRef(r) => {
                if let Some(node) = stack.last_mut() {
                    reference(&mut node.text, &r)?;
                }
            }
            Event::DocType(_) => return Err(INVALID),
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(INVALID);
    }
    root.ok_or(INVALID)
}
