//! The EWS wire layer: signed-in connection, NTLM, SOAP builders and decoders, typed operations.

mod client;
mod conn;
mod decode;
mod ntlm;
mod page;
mod soap;
mod xml;

pub(super) use client::calendar::{Edit, Written};
pub(super) use client::{Client, Folders, MAX_IDS, MAX_MIME_IDS, Outcome};
pub(super) use conn::{Choice, Config, DEADLINE, clock, endpoint};
pub(super) use decode::calendar::{CalendarItem, Lock};
pub(super) use decode::detail::{Attendee, Cancelled, EventDetail};
pub(super) use decode::{Item, MAX_MIME, Party};
pub(super) use soap::calendar::{
    Answer, Appointment, Change as CalendarChange, MAX_CURSOR_MS, MAX_ENTRIES, Reminder, When,
    create_appointment, is_change_key, respond, update_appointment,
};
pub(super) use soap::{Change, Condition, Role};

#[cfg(test)]
pub(super) mod tests;
