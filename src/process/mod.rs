//! Bounded subprocess transport for providers with an official command interface.
pub mod async_run;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub fn run(
    program: &str,
    args: &[String],
    input: &[u8],
    timeout: Duration,
    limit: usize,
) -> Result<Vec<u8>, &'static str> {
    if input.len() > limit {
        return Err("process_input_too_large");
    }
    let mut child = Command::new(program)
        .args(args)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "process_unavailable")?;
    let pid = child.id();
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let result = (|| {
        nonblocking(stdin.as_ref().unwrap())?;
        nonblocking(&stdout)?;
        nonblocking(&stderr)?;
        let started = Instant::now();
        let mut written = 0;
        let mut output = Vec::new();
        let mut diagnostics = 0;
        let mut out_done = false;
        let mut err_done = false;
        let mut status = None;
        loop {
            if started.elapsed() >= timeout {
                return Err("process_timed_out");
            }
            let mut progressed = false;
            if written == input.len() {
                stdin.take();
            } else if let Some(pipe) = stdin.as_mut() {
                let end = written.saturating_add(65536).min(input.len());
                match pipe.write(&input[written..end]) {
                    Ok(0) => return Err("process_input_failed"),
                    Ok(n) => {
                        written += n;
                        progressed = true;
                    }
                    Err(e) if pending(&e) => (),
                    Err(_) => return Err("process_input_failed"),
                }
            }
            // One bounded read per stream per iteration: continuous output must
            // not starve input, stderr draining, or the deadline check.
            for (pipe, done, capture) in [
                (&mut stdout as &mut dyn Read, &mut out_done, true),
                (&mut stderr as &mut dyn Read, &mut err_done, false),
            ] {
                if *done {
                    continue;
                }
                let mut chunk = [0; 65536];
                match pipe.read(&mut chunk) {
                    Ok(0) => {
                        *done = true;
                        progressed = true;
                    }
                    Ok(n) => {
                        progressed = true;
                        let size = if capture { output.len() } else { diagnostics };
                        if n > limit.saturating_sub(size) {
                            return Err("process_output_too_large");
                        }
                        if capture {
                            output.extend_from_slice(&chunk[..n]);
                        } else {
                            diagnostics += n;
                        } // Never forward diagnostics.
                    }
                    Err(e) if pending(&e) => (),
                    Err(_) => return Err("process_output_failed"),
                }
            }
            if status.is_none() {
                status = child.try_wait().map_err(|_| "process_wait_failed")?;
            }
            if out_done
                && err_done
                && stdin.is_none()
                && let Some(status) = status
            {
                return if status.success() {
                    Ok(output)
                } else {
                    Err("process_failed")
                };
            }
            if !progressed {
                std::thread::sleep(
                    Duration::from_millis(2).min(timeout.saturating_sub(started.elapsed())),
                );
            }
        }
    })();
    // Closing our nonblocking handles needs no worker join. Even a descendant
    // that escaped the process group cannot retain a reader past the deadline.
    drop(stdin);
    drop(stdout);
    drop(stderr);
    if result.is_err() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

fn pending(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
    )
}

fn nonblocking(pipe: &impl AsRawFd) -> Result<(), &'static str> {
    let fd = pipe.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("process_pipe_failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pipes_preserve_bytes_and_errors_never_include_diagnostics() {
        assert_eq!(
            run("/bin/cat", &[], b"a\0b\n", Duration::from_secs(1), 1024).unwrap(),
            b"a\0b\n"
        );
        assert_eq!(
            run(
                "/bin/sh",
                &["-c".into(), "printf synthetic-secret >&2; exit 7".into()],
                b"",
                Duration::from_secs(1),
                1024
            ),
            Err("process_failed")
        );
    }
    #[test]
    fn timeout_kills_descendants_holding_pipes() {
        let start = Instant::now();
        assert_eq!(
            run(
                "/bin/sh",
                &["-c".into(), "sleep 30 & wait".into()],
                b"",
                Duration::from_millis(50),
                1024
            ),
            Err("process_timed_out")
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn excess_output_stops_child() {
        assert_eq!(
            run(
                "/bin/sh",
                &["-c".into(), "while :; do printf 123456789; done".into()],
                b"",
                Duration::from_secs(1),
                64
            ),
            Err("process_output_too_large")
        );
    }

    #[test]
    fn escaped_descendant_cannot_hold_pipe_workers_past_deadline() {
        let start = Instant::now();
        let result = run(
            "python3",
            &["-c".into(), "import os,time\npid=os.fork()\nif pid==0:\n os.setsid()\n time.sleep(1.5)\n os._exit(0)\nos.waitpid(pid,0)".into()],
            b"",
            Duration::from_millis(150),
            1024,
        );
        assert_eq!(result, Err("process_timed_out"));
        // The escaped synthetic child exits by itself; our deadline must not
        // wait for that exit (the old scoped readers waited all 1.5 seconds).
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn full_duplex_large_input_and_output_make_progress() {
        let bytes = vec![42; 512 * 1024];
        assert_eq!(
            run("/bin/cat", &[], &bytes, Duration::from_secs(3), bytes.len()).unwrap(),
            bytes
        );
    }

    #[test]
    fn stderr_and_input_are_bounded_too() {
        assert_eq!(
            run(
                "/bin/sh",
                &["-c".into(), "while :; do printf 123456789 >&2; done".into()],
                b"",
                Duration::from_secs(1),
                64
            ),
            Err("process_output_too_large")
        );
        assert_eq!(
            run(
                "does-not-exist",
                &[],
                b"too large",
                Duration::from_secs(1),
                1
            ),
            Err("process_input_too_large")
        );
    }
}
