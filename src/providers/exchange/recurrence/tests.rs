use super::*;
use serde_json::json;

fn on(text: &str) -> NaiveDate {
    day(text).unwrap()
}

fn rule(request: Value, first: &str) -> Result<Recurrence, &'static str> {
    Recurrence::from_request(&request, on(first))
}

#[test]
fn a_request_is_made_into_the_pattern_of_its_first_day() {
    // 2026-10-27 is the fourth Tuesday of October; 2026-10-29 the fifth Thursday, which is the last.
    let made = |request, first| rule(request, first).unwrap();
    let weekly = made(
        json!({"frequency": "weekly", "interval": 2, "days": ["thursday", "tuesday"],
        "end": "count", "count": 6}),
        "2026-10-27",
    );
    let days = vec![Weekday::Tue, Weekday::Thu];
    assert_eq!(weekly.pattern, Pattern::Weekly(2, days));
    assert_eq!(weekly.end, End::Count(6));
    let cases = [
        (
            json!({"frequency": "daily", "interval": 3}),
            "2026-10-27",
            Pattern::Daily(3),
        ),
        (
            json!({"frequency": "weekly"}),
            "2026-10-27",
            Pattern::Weekly(1, vec![Weekday::Tue]),
        ),
        (
            json!({"frequency": "monthly"}),
            "2026-10-27",
            Pattern::Monthly(1, 27),
        ),
        (
            json!({"frequency": "monthly", "by": "weekday"}),
            "2026-10-27",
            Pattern::MonthlyBy(1, Weekday::Tue, 3),
        ),
        (
            json!({"frequency": "monthly", "by": "weekday"}),
            "2026-10-29",
            Pattern::MonthlyBy(1, Weekday::Thu, 4),
        ),
        (
            json!({"frequency": "yearly"}),
            "2026-10-27",
            Pattern::Yearly(10, 27),
        ),
        (
            json!({"frequency": "yearly", "by": "weekday"}),
            "2026-10-27",
            Pattern::YearlyBy(10, Weekday::Tue, 3),
        ),
    ];
    for (request, first, pattern) in cases {
        let made = made(request.clone(), first);
        assert_eq!((made.pattern, made.end), (pattern, End::Never), "{request}");
    }
    let until = made(
        json!({"frequency": "daily", "end": "until", "until": "2027-03-01"}),
        "2026-10-27",
    );
    assert_eq!(until.end, End::Until(on("2027-03-01")));
}

#[test]
fn what_the_schema_cannot_say_or_its_bounds_refuse_is_refused() {
    let first = "2026-10-27";
    for request in [
        json!({"frequency": "yearly", "interval": 2}),
        json!({"frequency": "daily", "interval": 0}),
        json!({"frequency": "daily", "interval": 1000}),
        json!({"frequency": "weekly", "interval": 100}),
        json!({"frequency": "monthly", "interval": 100}),
        json!({"frequency": "daily", "end": "count", "count": 1000}),
        json!({"frequency": "daily", "end": "count", "count": 0}),
        json!({"frequency": "daily", "end": "until", "until": "4501-01-01"}),
        json!({"frequency": "daily", "end": "until", "until": "2026-10-26"}),
        json!({"frequency": "daily", "end": "until", "until": "2027-3-1"}),
        json!({"frequency": "daily", "end": "count", "count": 5, "until": "2027-03-01"}),
        json!({"frequency": "daily", "count": 5}),
        json!({"frequency": "daily", "days": ["tuesday"]}),
        json!({"frequency": "weekly", "by": "date"}),
        // The first event is not on the rule, or a day is named twice or in another spelling.
        json!({"frequency": "weekly", "days": ["monday"]}),
        json!({"frequency": "weekly", "days": ["tuesday", "tuesday"]}),
        json!({"frequency": "weekly", "days": ["Tuesday"]}),
        json!({"frequency": "weekly", "days": []}),
        json!({"frequency": "fortnightly"}),
        json!({"frequency": "daily", "interval": 1.5}),
        json!({"frequency": "daily", "unexpected": true}),
        json!("weekly"),
    ] {
        assert_eq!(rule(request.clone(), first), Err(INVALID), "{request}");
    }
    // A first day before 1970 is no series.
    assert!(rule(json!({"frequency": "daily"}), "1969-12-31").is_err());
}

#[test]
fn a_rule_says_what_it_is_in_words_and_an_event_must_end_before_the_next() {
    let said = |request, first| rule(request, first).unwrap().sentence();
    assert_eq!(
        said(json!({"frequency": "daily"}), "2026-10-27"),
        "Every day"
    );
    let weekly = json!({"frequency": "weekly", "interval": 2, "days": ["monday", "tuesday", "friday"],
        "end": "until", "until": "2027-03-01"});
    assert_eq!(
        said(weekly, "2026-10-27"),
        "Every 2 weeks on Monday, Tuesday and Friday until 2027-03-01"
    );
    let monthly = json!({"frequency": "monthly", "by": "weekday", "end": "count", "count": 1});
    assert_eq!(
        said(monthly, "2026-10-29"),
        "Every month on the last Thursday, 1 time"
    );
    let yearly = json!({"frequency": "yearly", "end": "count", "count": 5});
    assert_eq!(
        said(yearly, "2026-02-14"),
        "Every year on 14 February, 5 times"
    );
    let weekly = rule(json!({"frequency": "weekly"}), "2026-10-27").unwrap();
    assert!(weekly.holds(7 * 24 * 60) && !weekly.holds(7 * 24 * 60 + 1));
    // The first Monday of October 2026 is the 5th and of 2027 the 4th: 364 days on.
    let yearly = json!({"frequency": "yearly", "by": "weekday"});
    let yearly = rule(yearly, "2026-10-05").unwrap();
    assert!(yearly.holds(364 * 24 * 60) && !yearly.holds(364 * 24 * 60 + 1));
    let two = rule(
        json!({"frequency": "weekly", "days": ["tuesday", "wednesday"]}),
        "2026-10-27",
    );
    assert!(!two.unwrap().holds(24 * 60 + 1));
    // The first day of a series is the day of its first instant somewhere: that day or a neighbour.
    let start = chrono::DateTime::parse_from_rfc3339("2026-10-27T23:30:00Z").unwrap();
    let ms = start.timestamp_millis();
    for (first, plausible) in [
        ("2026-10-27", true),
        ("2026-10-28", true),
        ("2026-10-26", true),
        ("2026-10-29", false),
    ] {
        assert_eq!(plausible_first_day(on(first), ms), plausible, "{first}");
    }
}
