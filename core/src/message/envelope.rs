//! Parse structural addresses before decoding encoded display names. Never feed
//! `MailHeader::get_value()` back into an address parser: decoded punctuation is
//! display text and must not become an envelope address.
use mailparse::{MailAddr, MailHeader, MailHeaderMap};

pub(crate) fn addresses(
    headers: &[MailHeader<'_>],
    name: &str,
) -> Result<Vec<String>, &'static str> {
    let mut out = Vec::new();
    for header in headers.get_all_headers(name) {
        for item in mailparse::addrparse_header(header)
            .map_err(|_| "invalid_message")?
            .iter()
        {
            match item {
                MailAddr::Single(single) => out.push(single.addr.clone()),
                MailAddr::Group(group) => {
                    out.extend(group.addrs.iter().map(|single| single.addr.clone()))
                }
            }
        }
    }
    if out
        .iter()
        .any(|address| address.is_empty() || address.chars().any(char::is_control))
    {
        return Err("invalid_message");
    }
    Ok(out)
}

pub(crate) fn sender(headers: &[MailHeader<'_>]) -> Result<Option<String>, &'static str> {
    let headers = headers.get_all_headers("From");
    if headers.is_empty() {
        return Ok(None);
    }
    if headers.len() != 1 {
        return Err("invalid_message");
    }
    let address = mailparse::addrparse_header(headers[0])
        .map_err(|_| "invalid_message")?
        .extract_single_info()
        .ok_or("invalid_message")?
        .addr;
    if address.is_empty() || address.chars().any(char::is_control) {
        return Err("invalid_message");
    }
    Ok(Some(address))
}
