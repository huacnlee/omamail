//! A conservative recognizer for uncompressed XML streams, not a PDF validator.
//! No decompression, reference resolution, rendering, or external resources.
//! Unsupported syntax keeps the ordinary active-content refusal in place.
use std::collections::HashSet;
use std::sync::LazyLock;

const REFUSED_NAMES: &[&[u8]] = &[
    b"OpenAction",
    b"AA",
    b"JavaScript",
    b"JS",
    b"Launch",
    b"XFA",
    b"RichMedia",
    b"Rendition",
    b"Movie",
    b"Sound",
    b"3D",
    b"ObjStm",
    b"Encrypt",
    b"XRef",
    b"XRefStm",
    b"Prev",
];

fn decoded_name(raw: &[u8]) -> Option<Vec<u8>> {
    let mut name = Vec::new();
    let mut at = 0;
    while at < raw.len() {
        let byte = raw[at];
        at += 1;
        if byte == b'#' {
            let hex = raw.get(at..at + 2)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            name.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            at += 2;
        } else {
            name.push(byte);
        }
        if name.len() > 1024 {
            return None;
        }
    }
    Some(name)
}

fn has_refused_name(bytes: &[u8]) -> bool {
    // An xref can point inside a string or a stream. Check ALL original bytes,
    // including spans skipped by the recognizer, for native action/opaque
    // object names. False positives here retain the old refusal to open.
    bytes.split(|b| *b == b'/').skip(1).any(|part| {
        let end = part
            .iter()
            .position(|b| delimiter(*b))
            .unwrap_or(part.len());
        decoded_name(&part[..end])
            .is_some_and(|name| name.contains(&0) || REFUSED_NAMES.contains(&name.as_slice()))
    })
}

fn xml_declaration(bytes: &[u8]) -> bool {
    // XML 1.0/1.1 declaration grammar, not arbitrary processing instructions.
    // Attribute order, quoting and the complete closing ?> are significant.
    static DECLARATION: LazyLock<regex::bytes::Regex> = LazyLock::new(|| {
        regex::bytes::Regex::new(concat!(
            r#"\A<\?xml[\x20\t\r\n]+version[\x20\t\r\n]*=[\x20\t\r\n]*(?:"1\.[01]"|'1\.[01]')"#,
            r#"(?:[\x20\t\r\n]+encoding[\x20\t\r\n]*=[\x20\t\r\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?"#,
            r#"(?:[\x20\t\r\n]+standalone[\x20\t\r\n]*=[\x20\t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\x20\t\r\n]*\?>"#,
        )).unwrap()
    });
    DECLARATION.is_match(&bytes[..bytes.len().min(1024)])
}

#[derive(Default)]
struct Dictionary {
    kind: Option<Vec<u8>>,
    subtype: Option<Vec<u8>>,
    length: Option<usize>,
    filtered: bool,
}

enum Value {
    Name(Vec<u8>),
    Integer(usize),
    Dictionary(Dictionary),
    Other,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

fn space(byte: u8) -> bool {
    matches!(byte, 0 | b'\t' | b'\n' | 12 | b'\r' | b' ')
}

fn delimiter(byte: u8) -> bool {
    space(byte) || b"()<>[]{}/%".contains(&byte)
}

impl Reader<'_> {
    fn whitespace(&mut self) {
        loop {
            while self.bytes.get(self.at).is_some_and(|b| space(*b)) {
                self.at += 1;
            }
            if self.bytes.get(self.at) != Some(&b'%') {
                break;
            }
            while self
                .bytes
                .get(self.at)
                .is_some_and(|b| !b"\r\n".contains(b))
            {
                self.at += 1;
            }
        }
    }

    fn word(&mut self) -> Option<&[u8]> {
        self.whitespace();
        let start = self.at;
        while self.bytes.get(self.at).is_some_and(|b| !delimiter(*b)) {
            self.at += 1;
            if self.at - start > 128 {
                return None;
            }
        }
        (self.at > start).then_some(&self.bytes[start..self.at])
    }

    fn keyword(&mut self, word: &[u8]) -> Option<()> {
        (self.word()? == word).then_some(())
    }

    fn integer(&mut self) -> Option<usize> {
        let word = self.word()?;
        if !word.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(word).ok()?.parse().ok()
    }

    fn name(&mut self) -> Option<Vec<u8>> {
        self.whitespace();
        if self.bytes.get(self.at) != Some(&b'/') {
            return None;
        }
        self.at += 1;
        let start = self.at;
        while self.bytes.get(self.at).is_some_and(|b| !delimiter(*b)) {
            self.at += 1;
            if self.at - start > 3072 {
                return None;
            }
        }
        let name = decoded_name(&self.bytes[start..self.at])?;
        (!name.contains(&0)).then_some(name)
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > 32 {
            return None;
        }
        self.whitespace();
        match *self.bytes.get(self.at)? {
            b'/' => Some(Value::Name(self.name()?)),
            b'(' => {
                self.at += 1;
                let mut nesting = 1usize;
                while nesting > 0 {
                    let byte = *self.bytes.get(self.at)?;
                    self.at += 1;
                    match byte {
                        b'\\' => {
                            self.bytes.get(self.at)?;
                            self.at += 1;
                        }
                        b'(' => nesting += 1,
                        b')' => nesting -= 1,
                        _ => (),
                    }
                    if nesting > 32 {
                        return None;
                    }
                }
                Some(Value::Other)
            }
            b'[' => {
                self.at += 1;
                loop {
                    self.whitespace();
                    if self.bytes.get(self.at) == Some(&b']') {
                        self.at += 1;
                        return Some(Value::Other);
                    }
                    self.value(depth + 1)?;
                }
            }
            b'<' if self.bytes.get(self.at + 1) == Some(&b'<') => {
                self.at += 2;
                let mut dictionary = Dictionary::default();
                let mut keys = HashSet::new();
                loop {
                    self.whitespace();
                    if self.bytes.get(self.at..self.at + 2) == Some(b">>") {
                        self.at += 2;
                        return Some(Value::Dictionary(dictionary));
                    }
                    let key = self.name()?;
                    if !keys.insert(key.clone()) {
                        return None;
                    }
                    if keys.len() > 4096 {
                        return None;
                    }
                    let value = self.value(depth + 1)?;
                    match (key.as_slice(), value) {
                        (b"Type", Value::Name(name)) => dictionary.kind = Some(name),
                        (b"Subtype", Value::Name(name)) => dictionary.subtype = Some(name),
                        (b"Length", Value::Integer(length)) => dictionary.length = Some(length),
                        (b"Filter" | b"F" | b"FFilter" | b"FDecodeParms", _) => {
                            dictionary.filtered = true;
                        }
                        _ => (),
                    }
                }
            }
            b'<' => {
                self.at += 1;
                loop {
                    let byte = *self.bytes.get(self.at)?;
                    self.at += 1;
                    if byte == b'>' {
                        return Some(Value::Other);
                    }
                    if !space(byte) && !byte.is_ascii_hexdigit() {
                        return None;
                    }
                }
            }
            _ => {
                let word = self.word()?;
                if [b"true".as_slice(), b"false", b"null"].contains(&word) {
                    return Some(Value::Other);
                }
                if !word
                    .iter()
                    .all(|b| b.is_ascii_digit() || b"+-.".contains(b))
                    || !std::str::from_utf8(word)
                        .ok()?
                        .parse::<f64>()
                        .ok()?
                        .is_finite()
                {
                    return None;
                }
                let integer = if word.iter().all(u8::is_ascii_digit) {
                    std::str::from_utf8(word).ok()?.parse::<usize>().ok()
                } else {
                    None
                };
                let end = self.at;
                if integer.is_some() && self.integer().is_some() && self.keyword(b"R").is_some() {
                    return Some(Value::Other);
                }
                self.at = end;
                Some(integer.map_or(Value::Other, Value::Integer))
            }
        }
    }
}

/// Positions of declarations whose five-byte marker may be masked for scanning.
/// Every other byte, including the rest of each XML stream, is still scanned.
pub(super) fn xml_declarations(bytes: &[u8]) -> Option<Vec<usize>> {
    if bytes.len() > super::MAX_BYTES
        || !(bytes.starts_with(b"%PDF-1.")
            && bytes.get(7).is_some_and(|b| (b'0'..=b'7').contains(b))
            || bytes.starts_with(b"%PDF-2.0"))
        || !bytes.get(8).is_some_and(|b| b"\r\n".contains(b))
        || has_refused_name(bytes)
    {
        return None;
    }
    let end = bytes.iter().rposition(|b| !space(*b))? + 1;
    let eof = end.checked_sub(5)?;
    if bytes.get(eof..end)? != b"%%EOF" {
        return None;
    }
    let mut reader = Reader {
        bytes: &bytes[..eof],
        at: 8,
    };
    let mut declarations = Vec::new();
    loop {
        reader.whitespace();
        let start = reader.at;
        let word = reader.word()?;
        if word == b"xref" {
            // Cross-reference tables contain only integers and n/f markers.
            // The final startxref must point to this exact table, not a prefix
            // supplied alongside an unrelated document.
            loop {
                let word = reader.word()?;
                if word == b"trailer" {
                    break;
                }
                if ![b"n".as_slice(), b"f"].contains(&word) && !word.iter().all(u8::is_ascii_digit)
                {
                    return None;
                }
            }
            if !matches!(reader.value(0)?, Value::Dictionary(_)) {
                return None;
            }
            reader.keyword(b"startxref")?;
            if reader.integer()? != start {
                return None;
            }
            break;
        }
        reader.at = start;
        reader.integer()?;
        reader.integer()?;
        reader.keyword(b"obj")?;
        let value = reader.value(0)?;
        reader.whitespace();
        let after_value = reader.at;
        if reader.keyword(b"stream").is_some() {
            let Value::Dictionary(dictionary) = value else {
                return None;
            };
            // PDF stream data starts after LF or CRLF, not arbitrary whitespace.
            if reader.bytes.get(reader.at) == Some(&b'\r') {
                reader.at += 1;
            }
            if reader.bytes.get(reader.at) != Some(&b'\n') {
                return None;
            }
            reader.at += 1;
            let data_start = reader.at;
            reader.at = data_start.checked_add(dictionary.length?)?;
            let stream = reader.bytes.get(data_start..reader.at)?;
            let kind = dictionary.kind.as_deref();
            let subtype = dictionary.subtype.as_deref();
            if !dictionary.filtered
                && (kind == Some(b"EmbeddedFile")
                    && [b"text/xml".as_slice(), b"application/xml"].contains(&subtype?)
                    || kind == Some(b"Metadata") && subtype == Some(b"XML"))
            {
                let bom = usize::from(stream.starts_with(b"\xef\xbb\xbf")) * 3;
                let xml = &stream[bom..];
                if xml_declaration(xml) {
                    declarations.push(data_start + bom);
                }
            }
            // Never search for endstream through arbitrary bytes. Only the
            // declared length plus one optional line ending may precede it.
            if reader.bytes.get(reader.at) == Some(&b'\r') {
                reader.at += 1;
            }
            if reader.bytes.get(reader.at) == Some(&b'\n') {
                reader.at += 1;
            }
            if reader.bytes.get(reader.at..reader.at.checked_add(9)?)? != b"endstream" {
                return None;
            }
            reader.keyword(b"endstream")?;
        } else {
            reader.at = after_value;
        }
        reader.keyword(b"endobj")?;
    }
    reader.whitespace();
    (reader.at == reader.bytes.len() && !declarations.is_empty()).then_some(declarations)
}
