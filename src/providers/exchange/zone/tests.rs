use super::*;

#[test]
fn the_table_gives_the_common_zones_their_windows_id_and_guesses_nothing() {
    let mut seen = std::collections::HashSet::new();
    for (iana, id) in ZONES {
        assert!(seen.insert(*iana), "{iana} is listed twice");
        assert!(is_id(id), "{id} cannot be written as a zone id");
    }
    for (iana, id) in [
        ("Europe/Vienna", "W. Europe Standard Time"),
        ("Europe/Paris", "Romance Standard Time"),
        ("America/New_York", "Eastern Standard Time"),
        ("Pacific/Auckland", "New Zealand Standard Time"),
        ("Etc/UTC", "UTC"),
    ] {
        assert_eq!(windows(iana), Some(id), "{iana}");
    }
    for unknown in [
        "Europe/Atlantis",
        "Europe",
        "europe/vienna",
        "Europe/Vienna ",
        "",
    ] {
        assert_eq!(windows(unknown), None, "{unknown:?}");
    }
    // Nothing that could leave the attribute it is written into.
    let long = "a".repeat(65);
    for bad in ["", "a\"b", "a<b", "a&b", "a\nb", "é", "a/b", long.as_str()] {
        assert!(!is_id(bad), "{bad:?}");
    }
    assert!(is_id("Central Standard Time (Mexico)") && is_id("UTC+12"));
}

#[test]
fn the_name_of_the_zone_comes_from_tz_first_and_else_from_the_localtime_link() {
    let link = |path: &str| Some(Path::new(path).to_owned());
    let vienna = "/usr/share/zoneinfo/Europe/Vienna";
    for (tz, localtime, name) in [
        (Some(":Europe/Vienna"), None, Some("Europe/Vienna")),
        (Some(vienna), None, Some("Europe/Vienna")),
        (Some("Asia/Tokyo"), link(vienna), Some("Asia/Tokyo")),
        (Some(""), link(vienna), Some("Europe/Vienna")),
        (
            None,
            link("../usr/share/zoneinfo/Europe/Vienna"),
            Some("Europe/Vienna"),
        ),
        // A POSIX rule names no zone, and the link is not looked behind it.
        (Some("CET-1CEST,M3.5.0,M10.5.0/3"), link(vienna), None),
        (None, link("/etc/somewhere-else"), None),
        (None, None, None),
    ] {
        let found = iana_name(tz, localtime.as_deref());
        assert_eq!(found.as_deref(), name, "{tz:?} {localtime:?}");
    }
}

#[tokio::test]
async fn the_computers_zone_is_a_known_one_or_utc() {
    assert!(is_id(local()));
    let zone = TEST_ZONE.scope("Romance Standard Time", async { local() });
    assert_eq!(zone.await, "Romance Standard Time");
}

#[test]
fn a_windows_key_name_is_read_to_its_nul_and_taken_only_when_listed() {
    let units = |text: &str, size: usize| {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.resize(size, 0);
        units
    };
    assert_eq!(
        key_name(&units("W. Europe Standard Time", 128)),
        "W. Europe Standard Time"
    );
    assert_eq!(key_name(&units("UTC", 3)), "UTC");
    assert_eq!(key_name(&units("", 128)), "");
    assert_eq!(
        listed("W. Europe Standard Time"),
        Some("W. Europe Standard Time")
    );
    assert_eq!(listed("UTC"), Some("UTC"));
    for unknown in [
        "",
        "Atlantis Standard Time",
        "w. europe standard time",
        "Europe/Vienna",
    ] {
        assert_eq!(listed(unknown), None, "{unknown:?}");
    }
    // Automatic daylight saving turned off: a zone that has it keeps standard time all year here,
    // which its id does not say, so it is not known; one without daylight saving is unaffected.
    let vienna = "W. Europe Standard Time";
    assert_eq!(chosen(vienna, false, true), Some(vienna));
    assert_eq!(chosen(vienna, true, true), None);
    assert_eq!(chosen("UTC", true, false), Some("UTC"));
    assert_eq!(chosen("Atlantis Standard Time", false, false), None);
}
