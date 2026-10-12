use super::*;

fn list(addresses: &[&str]) -> Vec<String> {
    addresses.iter().map(|a| (*a).to_owned()).collect()
}

#[test]
fn an_address_is_one_at_sign_between_a_local_part_and_a_dotted_domain_and_never_repaired() {
    for good in [
        "ada@example.org",
        "ada.lovelace@mail.example.org",
        "a+tag@example.org",
        "o'neil@example.org",
        "x@a-b.example.co.uk",
        "A@EXAMPLE.ORG",
    ] {
        assert!(is_address(good), "{good}");
    }
    for bad in [
        "",
        "ada",
        "@example.org",
        "ada@",
        "ada@example",
        "ada@@example.org",
        "a@b@example.org",
        "Ada <ada@example.org>",
        "<ada@example.org>",
        "ada@example.org,bob@example.org",
        "ada@example.org;bob@example.org",
        " ada@example.org",
        "ada@example.org\r\nBcc: x@example.org",
        "ada\u{0}@example.org",
        "\"ada\"@example.org",
        "ada(comment)@example.org",
        ".ada@example.org",
        "ada.@example.org",
        "a..da@example.org",
        "ada@example..org",
        "ada@-example.org",
        "adä@example.org",
        "ada@example.org\u{200b}",
    ] {
        assert!(!is_address(bad), "{bad:?}");
    }
    // Bounded in total, in the local part and in each label.
    let local = "a".repeat(MAX_LOCAL);
    assert!(is_address(&format!("{local}@example.org")));
    assert!(!is_address(&format!("{local}a@example.org")));
    assert!(!is_address(&format!(
        "ada@{}.org",
        "b".repeat(MAX_LABEL + 1)
    )));
    let domain = ["c", "d", "e", "f"].map(|c| c.repeat(60)).join(".");
    let fits = format!("{}@{domain}", "g".repeat(MAX_ADDRESS - domain.len() - 1));
    assert!(is_address(&fits) && !is_address(&format!("g{fits}")));
}

#[test]
fn the_lists_hold_nobody_twice_nobody_empty_not_the_owner_and_at_most_200_together() {
    let (ada, bob) = (list(&["ada@example.org"]), list(&["bob@example.org"]));
    assert!(check(&ada, &bob, "me@example.org").is_ok());
    assert!(check(&[], &[], "").is_ok(), "who needs somebody says so");
    assert!(check(&list(&["ada@example.org", "ADA@example.org"]), &[], "").is_err());
    assert!(check(&ada, &list(&["Ada@Example.Org"]), "").is_err());
    assert!(check(&list(&[""]), &[], "").is_err());
    assert!(check(&list(&["ME@example.org"]), &[], "me@example.org").is_err());
    assert!(check(&[], &list(&["me@EXAMPLE.org"]), "me@example.org").is_err());
    let many: Vec<String> = (0..=200).map(|n| format!("p{n}@example.org")).collect();
    assert!(check(&many[..100], &many[100..200], "").is_ok());
    assert!(check(&many[..100], &many[100..], "").is_err());
}
