use std::process::Command;

pub(crate) fn process_argv(pid: u32) -> Vec<u8> {
    let query = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine");
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        !output.stdout.is_empty(),
        "child process command line missing"
    );
    output.stdout
}
