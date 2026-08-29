pub(crate) fn valid_event_calendar(value: &str, max_bytes: usize) -> bool {
    if value.len() > max_bytes || !value.ends_with("\r\n") {
        return false;
    }
    let Some(body) = value.strip_suffix("\r\n") else {
        return false;
    };
    let bytes = value.as_bytes();
    if bytes.iter().enumerate().any(|(index, byte)| {
        (*byte == b'\r' && bytes.get(index + 1) != Some(&b'\n'))
            || (*byte == b'\n' && index.checked_sub(1).and_then(|i| bytes.get(i)) != Some(&b'\r'))
    }) || value.chars().any(|character| {
        character == '\0'
            || (character.is_control()
                && character != '\r'
                && character != '\n'
                && character != '\t')
    }) {
        return false;
    }
    let lines: Vec<&str> = body.split("\r\n").collect();
    let mut calendar = false;
    let mut event = false;
    let mut saw_event = false;
    for (index, line) in lines.iter().enumerate() {
        match *line {
            "BEGIN:VCALENDAR" if index == 0 && !calendar && !event => calendar = true,
            "BEGIN:VEVENT" if calendar && !event && !saw_event => {
                event = true;
                saw_event = true;
            }
            "END:VEVENT" if calendar && event => event = false,
            "END:VCALENDAR" if index + 1 == lines.len() && calendar && !event => calendar = false,
            "BEGIN:VCALENDAR" | "END:VCALENDAR" | "BEGIN:VEVENT" | "END:VEVENT" => return false,
            _ if !calendar || (saw_event && !event) => return false,
            _ => {}
        }
    }
    !calendar && !event && saw_event
}
