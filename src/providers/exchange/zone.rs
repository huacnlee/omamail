//! The Windows time zone an all-day appointment is made in.
//!
//! Exchange keeps an all-day event as midnight to midnight *in the zone it was created in*, and a
//! client in another zone sees it start somewhere else than midnight: Microsoft's "Create all-day
//! events" says it can then "appear as an all-day event with extra days", and recommends "the user's
//! preferred time zone" (the zone of "the primary calendaring client"). A request that names no zone
//! creates in UTC (Table 2 of "Time zones and EWS in Exchange"), which would put the owner's all-day
//! events on the wrong side of their own Outlook's midnight. So an all-day write names the owner's
//! zone as a `TimeZoneContext`, by the Windows id the server keeps zones under
//! (`Eastern Standard Time`), and everything else about time stays UTC instants: a timed event
//! needs no zone at all.
//!
//! An id is all the header needs ("Create appointments in a specific time zone" writes the bare
//! `Id`), and a definition of our own would be what Microsoft's `Id (TimeZone)` page advises
//! against: use "time zone definitions that are supported by the Exchange server". So the one thing
//! needed is the id of the zone the computer is in. Neither the standard library nor the crates
//! here know Windows ids, so this lists the IANA names a Unix system names its zone by (`TZ`, or the
//! link `/etc/localtime`) for the common zones, one Windows id each. The ids are Microsoft's: most
//! are on its "Default Time Zones" page, the rest (the United States, Canada and Australia beyond
//! the default ones) are the long-standing names of those zones. A zone that is not listed is not
//! guessed: the event is made in UTC (`UTC`, which every Exchange knows), where this client reads it
//! back on the day it was made for and an Outlook elsewhere may draw it a few hours off midnight.
//! Zones with the same rules share an id on purpose (Paris is `Romance Standard Time` and Vienna
//! `W. Europe Standard Time`, which differ only in a name): the id only has to give the same
//! midnights. Istanbul is left out: Windows renamed that id (`Turkey` to `Türkiye Standard Time`), so
//! which one a server has depends on its operating system.

use std::path::Path;

/// What an unknown zone, or none, is made in.
pub(super) const UTC: &str = "UTC";

#[cfg(test)]
tokio::task_local! {
    /// The zone a test says the computer is in.
    pub(super) static TEST_ZONE: &'static str;
}

/// The Windows id of the zone this computer is in, or `UTC` when it is not one this knows.
pub(super) fn local() -> &'static str {
    known().unwrap_or(UTC)
}

/// The Windows id of the zone this computer is in, `None` when it is not one this knows (an empty
/// test zone says that too). A single event can do without it; a repeating one cannot, because the
/// server repeats it on the wall of the zone it was made in, and one made in UTC would move an hour
/// when the clocks change: a computer whose zone is not known makes no series.
pub(super) fn known() -> Option<&'static str> {
    #[cfg(test)]
    if let Ok(zone) = TEST_ZONE.try_with(|zone| *zone) {
        return Some(zone).filter(|zone| !zone.is_empty());
    }
    iana_name(
        std::env::var("TZ").ok().as_deref(),
        std::fs::read_link("/etc/localtime").ok().as_deref(),
    )
    .and_then(|name| windows(&name))
}

/// The IANA name of a zone from the `TZ` variable (`Europe/Vienna`, or `:Europe/Vienna`, or a path
/// into a zoneinfo directory) or else the target of the `/etc/localtime` link. A `TZ` that is a
/// POSIX rule (`CET-1CEST`) names no zone and is not looked behind.
fn iana_name(tz: Option<&str>, link: Option<&Path>) -> Option<String> {
    let after_zoneinfo = |text: &str| {
        text.split_once("zoneinfo/")
            .map(|(_, name)| name.to_owned())
    };
    let named = |name: String| {
        let plain = name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'));
        plain.then_some(name)
    };
    if let Some(tz) = tz.filter(|tz| !tz.is_empty()) {
        let tz = tz.strip_prefix(':').unwrap_or(tz);
        return after_zoneinfo(tz)
            .or_else(|| tz.contains('/').then(|| tz.to_owned()))
            .and_then(named);
    }
    after_zoneinfo(link?.to_str()?).and_then(named)
}

/// The Windows id for an IANA zone name, if it is one of those below.
fn windows(iana: &str) -> Option<&'static str> {
    ZONES
        .iter()
        .find(|(name, _)| *name == iana)
        .map(|(_, windows)| *windows)
}

/// IANA zone name, Windows id. Grouped by region, looked up by name.
const ZONES: &[(&str, &str)] = &[
    ("Etc/UTC", "UTC"),
    ("UTC", "UTC"),
    ("Etc/GMT", "UTC"),
    ("GMT", "UTC"),
    // Europe and the Mediterranean.
    ("Europe/London", "GMT Standard Time"),
    ("Europe/Dublin", "GMT Standard Time"),
    ("Europe/Lisbon", "GMT Standard Time"),
    ("Atlantic/Canary", "GMT Standard Time"),
    ("Atlantic/Madeira", "GMT Standard Time"),
    ("Atlantic/Reykjavik", "Greenwich Standard Time"),
    ("Europe/Berlin", "W. Europe Standard Time"),
    ("Europe/Vienna", "W. Europe Standard Time"),
    ("Europe/Zurich", "W. Europe Standard Time"),
    ("Europe/Amsterdam", "W. Europe Standard Time"),
    ("Europe/Rome", "W. Europe Standard Time"),
    ("Europe/Stockholm", "W. Europe Standard Time"),
    ("Europe/Oslo", "W. Europe Standard Time"),
    ("Europe/Luxembourg", "W. Europe Standard Time"),
    ("Europe/Malta", "W. Europe Standard Time"),
    ("Europe/Monaco", "W. Europe Standard Time"),
    ("Europe/Vaduz", "W. Europe Standard Time"),
    ("Europe/Andorra", "W. Europe Standard Time"),
    ("Europe/Paris", "Romance Standard Time"),
    ("Europe/Madrid", "Romance Standard Time"),
    ("Europe/Brussels", "Romance Standard Time"),
    ("Europe/Copenhagen", "Romance Standard Time"),
    ("Europe/Prague", "Central Europe Standard Time"),
    ("Europe/Budapest", "Central Europe Standard Time"),
    ("Europe/Belgrade", "Central Europe Standard Time"),
    ("Europe/Bratislava", "Central Europe Standard Time"),
    ("Europe/Ljubljana", "Central Europe Standard Time"),
    ("Europe/Zagreb", "Central Europe Standard Time"),
    ("Europe/Warsaw", "Central European Standard Time"),
    ("Europe/Sarajevo", "Central European Standard Time"),
    ("Europe/Skopje", "Central European Standard Time"),
    ("Europe/Helsinki", "FLE Standard Time"),
    ("Europe/Kyiv", "FLE Standard Time"),
    ("Europe/Kiev", "FLE Standard Time"),
    ("Europe/Riga", "FLE Standard Time"),
    ("Europe/Tallinn", "FLE Standard Time"),
    ("Europe/Vilnius", "FLE Standard Time"),
    ("Europe/Sofia", "FLE Standard Time"),
    ("Europe/Athens", "GTB Standard Time"),
    ("Europe/Bucharest", "GTB Standard Time"),
    ("Europe/Moscow", "Russian Standard Time"),
    ("Europe/Minsk", "Belarus Standard Time"),
    // Africa and the Middle East.
    ("Africa/Cairo", "Egypt Standard Time"),
    ("Africa/Johannesburg", "South Africa Standard Time"),
    ("Africa/Lagos", "W. Central Africa Standard Time"),
    ("Africa/Nairobi", "E. Africa Standard Time"),
    ("Asia/Jerusalem", "Israel Standard Time"),
    ("Asia/Riyadh", "Arab Standard Time"),
    ("Asia/Dubai", "Arabian Standard Time"),
    ("Asia/Tehran", "Iran Standard Time"),
    // Asia and the Pacific.
    ("Asia/Karachi", "Pakistan Standard Time"),
    ("Asia/Kolkata", "India Standard Time"),
    ("Asia/Calcutta", "India Standard Time"),
    ("Asia/Dhaka", "Bangladesh Standard Time"),
    ("Asia/Bangkok", "SE Asia Standard Time"),
    ("Asia/Jakarta", "SE Asia Standard Time"),
    ("Asia/Ho_Chi_Minh", "SE Asia Standard Time"),
    ("Asia/Shanghai", "China Standard Time"),
    ("Asia/Hong_Kong", "China Standard Time"),
    ("Asia/Singapore", "Singapore Standard Time"),
    ("Asia/Kuala_Lumpur", "Singapore Standard Time"),
    ("Asia/Manila", "Singapore Standard Time"),
    ("Asia/Taipei", "Taipei Standard Time"),
    ("Asia/Seoul", "Korea Standard Time"),
    ("Asia/Tokyo", "Tokyo Standard Time"),
    ("Australia/Perth", "W. Australia Standard Time"),
    ("Australia/Darwin", "AUS Central Standard Time"),
    ("Australia/Adelaide", "Cen. Australia Standard Time"),
    ("Australia/Brisbane", "E. Australia Standard Time"),
    ("Australia/Sydney", "AUS Eastern Standard Time"),
    ("Australia/Melbourne", "AUS Eastern Standard Time"),
    ("Australia/Canberra", "AUS Eastern Standard Time"),
    ("Australia/Hobart", "Tasmania Standard Time"),
    ("Pacific/Auckland", "New Zealand Standard Time"),
    ("Pacific/Fiji", "Fiji Standard Time"),
    ("Pacific/Honolulu", "Hawaiian Standard Time"),
    // The Americas.
    ("America/Anchorage", "Alaskan Standard Time"),
    ("America/Los_Angeles", "Pacific Standard Time"),
    ("America/Vancouver", "Pacific Standard Time"),
    ("America/Tijuana", "Pacific Standard Time"),
    ("America/Denver", "Mountain Standard Time"),
    ("America/Edmonton", "Mountain Standard Time"),
    ("America/Boise", "Mountain Standard Time"),
    ("America/Phoenix", "US Mountain Standard Time"),
    ("America/Chicago", "Central Standard Time"),
    ("America/Winnipeg", "Central Standard Time"),
    ("America/Regina", "Canada Central Standard Time"),
    ("America/Mexico_City", "Central Standard Time (Mexico)"),
    ("America/New_York", "Eastern Standard Time"),
    ("America/Detroit", "Eastern Standard Time"),
    ("America/Toronto", "Eastern Standard Time"),
    ("America/Indiana/Indianapolis", "US Eastern Standard Time"),
    ("America/Bogota", "SA Pacific Standard Time"),
    ("America/Lima", "SA Pacific Standard Time"),
    ("America/Caracas", "Venezuela Standard Time"),
    ("America/Halifax", "Atlantic Standard Time"),
    ("America/St_Johns", "Newfoundland Standard Time"),
    ("America/Santiago", "Pacific SA Standard Time"),
    ("America/Sao_Paulo", "E. South America Standard Time"),
    ("America/Argentina/Buenos_Aires", "Argentina Standard Time"),
    ("America/Buenos_Aires", "Argentina Standard Time"),
    ("America/Montevideo", "Montevideo Standard Time"),
];

/// Whether `id` is something that can be written as a zone id: what Windows names its zones with.
pub fn is_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'(' | b')' | b'+' | b'-')
        })
}

#[cfg(test)]
mod tests;
