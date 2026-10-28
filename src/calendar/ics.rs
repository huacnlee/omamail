//! The iCalendar structure a CalDAV invitation copy needs: components and
//! their property lines, unfolded on read and folded on write.

const MAX_DEPTH: usize = 4;
const MAX_LINES: usize = 20_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Component {
    pub name: String,
    pub lines: Vec<String>,
    pub children: Vec<Component>,
}

fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let (Some(rest), Some(last)) = (line.strip_prefix([' ', '\t']), out.last_mut()) {
            last.push_str(rest);
            continue;
        }
        if !line.is_empty() {
            out.push(line.to_owned());
        }
    }
    out
}

pub fn name(line: &str) -> String {
    line.split([';', ':'])
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// The parameters and value of a line, split at the first colon outside a
/// quoted parameter value.
fn split(line: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (index, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some((&line[..index], &line[index + 1..])),
            _ => {}
        }
    }
    None
}

pub fn value(line: &str) -> &str {
    split(line).map_or("", |(_, value)| value)
}

pub fn param(line: &str, wanted: &str) -> Option<String> {
    let (head, _) = split(line)?;
    head.split(';').skip(1).find_map(|piece| {
        let (key, value) = piece.split_once('=')?;
        key.eq_ignore_ascii_case(wanted)
            .then(|| value.trim_matches('"').to_owned())
    })
}

pub fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

pub fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace(',', "\\,")
        .replace(';', "\\;")
}

impl Component {
    pub fn new(name: &str) -> Self {
        Component {
            name: name.into(),
            lines: Vec::new(),
            children: Vec::new(),
        }
    }

    pub fn parse(text: &str) -> Result<Component, &'static str> {
        let lines = unfold(text);
        if lines.len() > MAX_LINES {
            return Err("calendar_input_too_large");
        }
        let mut stack: Vec<Component> = Vec::new();
        let mut root = None;
        for line in lines {
            if line.chars().any(|c| c.is_control() && c != '\t') {
                return Err("calendar_invalid_input");
            }
            match name(&line).as_str() {
                "BEGIN" => {
                    if root.is_some() || stack.len() >= MAX_DEPTH {
                        return Err("calendar_invalid_input");
                    }
                    stack.push(Component::new(&value(&line).to_ascii_uppercase()));
                }
                "END" => {
                    let done = stack.pop().ok_or("calendar_invalid_input")?;
                    if !value(&line).eq_ignore_ascii_case(&done.name) {
                        return Err("calendar_invalid_input");
                    }
                    match stack.last_mut() {
                        Some(parent) => parent.children.push(done),
                        None => root = Some(done),
                    }
                }
                _ => {
                    if split(&line).is_none() {
                        return Err("calendar_invalid_input");
                    }
                    stack
                        .last_mut()
                        .ok_or("calendar_invalid_input")?
                        .lines
                        .push(line);
                }
            }
        }
        if !stack.is_empty() {
            return Err("calendar_invalid_input");
        }
        root.filter(|c| c.name == "VCALENDAR")
            .ok_or("calendar_invalid_input")
    }

    pub fn property(&self, wanted: &str) -> Option<&str> {
        self.lines
            .iter()
            .find(|line| name(line) == wanted)
            .map(String::as_str)
    }

    pub fn text(&self, wanted: &str) -> Option<String> {
        self.property(wanted).map(|line| unescape(value(line)))
    }

    pub fn remove(&mut self, wanted: &[&str]) {
        self.lines
            .retain(|line| !wanted.contains(&name(line).as_str()));
    }

    pub fn write(&self) -> String {
        let mut out = String::new();
        self.write_into(&mut out);
        out
    }

    fn write_into(&self, out: &mut String) {
        fold(&format!("BEGIN:{}", self.name), out);
        for line in &self.lines {
            fold(line, out);
        }
        for child in &self.children {
            child.write_into(out);
        }
        fold(&format!("END:{}", self.name), out);
    }
}

/// RFC 5545 lines are at most 75 octets; a continuation never splits a
/// UTF-8 sequence.
fn fold(line: &str, out: &mut String) {
    let mut width = 0;
    for c in line.chars() {
        if width + c.len_utf8() > 74 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += c.len_utf8();
    }
    out.push_str("\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folded_quoted_and_escaped_lines_round_trip() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:One\\, two\r\n  three\r\nORGANIZER;CN=\"Doe: J\":mailto:j@example.org\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let calendar = Component::parse(text).unwrap();
        let event = &calendar.children[0];
        assert_eq!(event.text("SUMMARY").unwrap(), "One, two three");
        let organizer = event.property("ORGANIZER").unwrap();
        assert_eq!(value(organizer), "mailto:j@example.org");
        assert_eq!(param(organizer, "cn").unwrap(), "Doe: J");
        let long = "x".repeat(200) + "日本語";
        let mut copy = calendar.clone();
        copy.children[0].lines.push(format!("DESCRIPTION:{long}"));
        let written = copy.write();
        assert!(written.lines().all(|line| line.len() <= 75));
        assert_eq!(
            Component::parse(&written).unwrap().children[0]
                .text("DESCRIPTION")
                .unwrap(),
            long
        );
    }

    #[test]
    fn unbalanced_or_controlled_input_is_refused() {
        for text in [
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n",
            "BEGIN:VCALENDAR\r\nSUMMARY:a\u{1b}b\r\nEND:VCALENDAR\r\n",
            "BEGIN:VEVENT\r\nEND:VEVENT\r\n",
            "BEGIN:VCALENDAR\r\nnot a property\r\nEND:VCALENDAR\r\n",
        ] {
            assert!(Component::parse(text).is_err(), "{text}");
        }
    }
}
