//! The rule of a repeating event: daily, weekly on chosen days, monthly or yearly by date or by
//! weekday; ending never, on a day or after a count; and the words that say one. Written from
//! Microsoft's Recurrence, DailyRecurrence, WeeklyRecurrence, AbsoluteMonthlyRecurrence,
//! RelativeMonthlyRecurrence, AbsoluteYearlyRecurrence, RelativeYearlyRecurrence, NoEndRecurrence,
//! EndDateRecurrence, NumberedRecurrence, DaysOfWeek, DayOfWeekIndex and Month pages and "Create a
//! recurring series by using EWS". Rules a change must not break:
//!
//! - **Only what the schema can say is accepted**, each bound as Microsoft gives it: an interval of 1
//!   to 999 days or 1 to 99 weeks or months, and none for a year (`AbsoluteYearlyRecurrence` has no
//!   `Interval`, so "every second year" is refused, never turned into every year); a day of the month
//!   from 1 to 31; a count from 1 to 999; an end date no later than the year 4500.
//! - **The first event is on the rule.** A weekly series whose `Start` is not its first occurrence
//!   "loses its time zone information", so a rule is made from the first event's day and refused when
//!   that day is not one of its days; a month or a year takes its day, month and weekday from it.
//! - **An event does not run into the next**: one longer than the shortest gap of its rule is refused.
//! - **The words are made here and are bounded**: a rule that cannot be said within those bounds (a
//!   pattern with no name here, a `DaysOfWeek` of `Weekday`) is "Repeats" and its kind.

use chrono::{Datelike, Days, NaiveDate, Weekday};
use serde_json::{Map, Value};

const INVALID: &str = "invalid_params";
/// The days and months as Microsoft spells them in `DaysOfWeek` and `Month`.
pub const DAYS: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
pub const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
/// `DayOfWeekIndex`: which of its weekdays in a month; a fifth is always the last.
pub const WEEKS: [&str; 5] = ["First", "Second", "Third", "Fourth", "Last"];
const MAX_YEAR: i32 = 4500;

pub fn day_name(day: Weekday) -> &'static str {
    DAYS[day.num_days_from_monday() as usize]
}

/// A weekday as Microsoft spells it, and no other way.
pub fn weekday(word: &str) -> Option<Weekday> {
    let at = DAYS.iter().position(|name| *name == word)?;
    Weekday::try_from(u8::try_from(at).ok()?).ok()
}

/// Which of its weekdays in its month a day is, as an index into `WEEKS`.
pub fn week_of(date: NaiveDate) -> usize {
    (date.day0() / 7).min(4) as usize
}

/// A pattern: an interval where the schema has one, then what the pattern repeats on (weeks are
/// indexes into `WEEKS`, months 1 to 12, days of a week distinct and from Monday).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pattern {
    Daily(u32),
    Weekly(u32, Vec<Weekday>),
    /// Interval, day of the month.
    Monthly(u32, u32),
    MonthlyBy(u32, Weekday, usize),
    /// Month, day of the month.
    Yearly(u32, u32),
    YearlyBy(u32, Weekday, usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Never,
    /// The last day an event may fall on.
    Until(NaiveDate),
    Count(u32),
}

/// A pattern, how it ends, and the day of the first event in the zone of the series.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recurrence {
    pub pattern: Pattern,
    pub end: End,
    pub start: NaiveDate,
}

/// What a master says of its repetition: its kind (`daily`, `weekly`, `monthly`, `yearly`, or empty),
/// the sentence, the day it starts when the server gave one, and the rule when every part of it was
/// read within Microsoft's bounds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Repeat {
    pub kind: &'static str,
    pub text: String,
    pub start: Option<NaiveDate>,
    pub rule: Option<Recurrence>,
}

impl Recurrence {
    /// Whether every number is inside what Microsoft's pages allow.
    pub fn in_range(&self) -> bool {
        let up_to = |value: u32, most: u32| (1..=most).contains(&value);
        let pattern = match &self.pattern {
            Pattern::Daily(n) => up_to(*n, 999),
            Pattern::Weekly(n, days) => {
                let order = |pair: &[Weekday]| {
                    pair[0].num_days_from_monday() < pair[1].num_days_from_monday()
                };
                up_to(*n, 99) && !days.is_empty() && days.windows(2).all(order)
            }
            Pattern::Monthly(n, day) => up_to(*n, 99) && up_to(*day, 31),
            Pattern::MonthlyBy(n, _, week) => up_to(*n, 99) && *week < WEEKS.len(),
            // The 29th of February is a day of some years; the 30th of none.
            Pattern::Yearly(month, day) => NaiveDate::from_ymd_opt(2000, *month, *day).is_some(),
            Pattern::YearlyBy(month, _, week) => up_to(*month, 12) && *week < WEEKS.len(),
        };
        let end = match self.end {
            End::Never => true,
            End::Count(count) => up_to(count, 999),
            End::Until(day) => day >= self.start && day.year() <= MAX_YEAR,
        };
        pattern && end && (1970..=MAX_YEAR).contains(&self.start.year())
    }

    /// Whether the first day is one of the days the rule says.
    pub fn starts_on_pattern(&self) -> bool {
        let first = self.start;
        let on =
            |weekday: Weekday, week: usize| first.weekday() == weekday && week_of(first) == week;
        match &self.pattern {
            Pattern::Daily(_) => true,
            Pattern::Weekly(_, days) => days.contains(&first.weekday()),
            Pattern::Monthly(_, day) => first.day() == *day,
            Pattern::MonthlyBy(_, weekday, week) => on(*weekday, *week),
            Pattern::Yearly(month, day) => first.month() == *month && first.day() == *day,
            Pattern::YearlyBy(month, weekday, week) => {
                first.month() == *month && on(*weekday, *week)
            }
        }
    }

    /// Whether an event of this many minutes ends before the next one may begin.
    pub fn holds(&self, minutes: i64) -> bool {
        let gap = match &self.pattern {
            Pattern::Daily(n) => i64::from(*n),
            Pattern::Weekly(n, days) if days.len() == 1 => i64::from(*n) * 7,
            Pattern::Weekly(..) => 1,
            Pattern::Monthly(n, _) | Pattern::MonthlyBy(n, ..) => i64::from(*n) * 28,
            Pattern::Yearly(..) => 365,
            // The same weekday of a month a year on can be 52 weeks later.
            Pattern::YearlyBy(..) => 364,
        };
        minutes <= gap * 24 * 60
    }

    /// The rule a request names (`recurrence`), made from the day of the first event: the caller names
    /// how often, the days of a week, whether a month or a year goes by date or by weekday, and the end.
    /// A member that is not one of these, or does not belong to the frequency, a number out of bounds
    /// and a first day that is not on the rule are `invalid_params`.
    pub fn from_request(value: &Value, first: NaiveDate) -> Result<Recurrence, &'static str> {
        let map = value.as_object().ok_or(INVALID)?;
        const KEYS: [&str; 8] = [
            "frequency",
            "interval",
            "days",
            "by",
            "end",
            "until",
            "count",
            "firstDate",
        ];
        if map.keys().any(|key| !KEYS.contains(&key.as_str())) {
            return Err(INVALID);
        }
        let frequency = word(map, "frequency")?.ok_or(INVALID)?;
        let interval = number(map, "interval")?.unwrap_or(1);
        let by_weekday = match (word(map, "by")?, frequency) {
            (None, _) => false,
            (Some("date"), "monthly" | "yearly") => false,
            (Some("weekday"), "monthly" | "yearly") => true,
            _ => return Err(INVALID),
        };
        if map.contains_key("days") && frequency != "weekly" {
            return Err(INVALID);
        }
        let (weekday, week) = (first.weekday(), week_of(first));
        let pattern = match frequency {
            "daily" => Pattern::Daily(interval),
            "weekly" => {
                // A request names a day in lower case: `monday`.
                let named = |day: &Value| {
                    let word = day.as_str()?;
                    let at = DAYS
                        .iter()
                        .position(|name| name.to_ascii_lowercase() == word)?;
                    Weekday::try_from(u8::try_from(at).ok()?).ok()
                };
                let mut days = match map.get("days") {
                    None => vec![weekday],
                    Some(Value::Array(list)) => list
                        .iter()
                        .map(named)
                        .collect::<Option<Vec<Weekday>>>()
                        .ok_or(INVALID)?,
                    Some(_) => return Err(INVALID),
                };
                days.sort_by_key(Weekday::num_days_from_monday);
                // A day named twice is a slip, not one day.
                if days.windows(2).any(|pair| pair[0] == pair[1]) {
                    return Err(INVALID);
                }
                Pattern::Weekly(interval, days)
            }
            "monthly" if by_weekday => Pattern::MonthlyBy(interval, weekday, week),
            "monthly" => Pattern::Monthly(interval, first.day()),
            // A year has no interval to write.
            "yearly" if interval != 1 => return Err(INVALID),
            "yearly" if by_weekday => Pattern::YearlyBy(first.month(), weekday, week),
            "yearly" => Pattern::Yearly(first.month(), first.day()),
            _ => return Err(INVALID),
        };
        let has = |key| map.contains_key(key);
        let end = match word(map, "end")? {
            None | Some("never") if !has("until") && !has("count") => End::Never,
            Some("until") if !has("count") => End::Until(day(word(map, "until")?.ok_or(INVALID)?)?),
            Some("count") if !has("until") => End::Count(number(map, "count")?.ok_or(INVALID)?),
            _ => return Err(INVALID),
        };
        let rule = Recurrence {
            pattern,
            end,
            start: first,
        };
        if rule.in_range() && rule.starts_on_pattern() {
            Ok(rule)
        } else {
            Err(INVALID)
        }
    }

    /// The rule in words: "Every 2 weeks on Monday and Thursday until 2027-03-01".
    pub fn sentence(&self) -> String {
        let every = |n: u32, unit: &str| match n {
            1 => format!("Every {unit}"),
            n => format!("Every {n} {unit}s"),
        };
        let nth = |weekday: Weekday, week: usize| {
            let week = WEEKS[week].to_ascii_lowercase();
            format!("the {week} {}", day_name(weekday))
        };
        let month = |month: u32| MONTHS[month as usize - 1];
        let mut text = match &self.pattern {
            Pattern::Daily(n) => every(*n, "day"),
            Pattern::Weekly(n, days) => {
                let names: Vec<&str> = days.iter().map(|day| day_name(*day)).collect();
                let list = match names.split_last() {
                    Some((last, rest)) if !rest.is_empty() => {
                        format!("{} and {last}", rest.join(", "))
                    }
                    _ => names.concat(),
                };
                format!("{} on {list}", every(*n, "week"))
            }
            Pattern::Monthly(n, day) => format!("{} on day {day}", every(*n, "month")),
            Pattern::MonthlyBy(n, weekday, week) => {
                format!("{} on {}", every(*n, "month"), nth(*weekday, *week))
            }
            Pattern::Yearly(m, day) => format!("Every year on {day} {}", month(*m)),
            Pattern::YearlyBy(m, weekday, week) => {
                format!("Every year on {} of {}", nth(*weekday, *week), month(*m))
            }
        };
        match self.end {
            End::Never => {}
            End::Until(day) => text += &format!(" until {day}"),
            End::Count(1) => text += ", 1 time",
            End::Count(count) => text += &format!(", {count} times"),
        }
        text
    }
}

fn word<'a>(map: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, &'static str> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(INVALID),
    }
}

fn number(map: &Map<String, Value>, key: &str) -> Result<Option<u32>, &'static str> {
    map.get(key)
        .map(|value| {
            value
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or(INVALID)
        })
        .transpose()
}

/// A day spelled `YYYY-MM-DD`, and no other way.
pub fn day(text: &str) -> Result<NaiveDate, &'static str> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .filter(|day| day.format("%Y-%m-%d").to_string() == text)
        .ok_or(INVALID)
}

/// Whether `first` can be the day an instant (milliseconds) falls on in some zone: no zone is more than
/// 14 hours ahead of UTC or 12 behind, so it is the UTC day or a neighbour. The one check of a caller's
/// local day that needs no zone data.
pub fn plausible_first_day(first: NaiveDate, start_ms: i64) -> bool {
    let Some(utc) = chrono::DateTime::from_timestamp_millis(start_ms).map(|at| at.date_naive())
    else {
        return false;
    };
    first == utc
        || utc.checked_add_days(Days::new(1)) == Some(first)
        || utc.checked_sub_days(Days::new(1)) == Some(first)
}

#[cfg(test)]
mod tests;
