//! Async, bounded, cancellation-safe transport for official provider tools.
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
struct Group(u32);
impl Drop for Group {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
async fn read(mut pipe: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::new();
    let mut bytes = [0; 16384];
    loop {
        let count = pipe
            .read(&mut bytes)
            .await
            .map_err(|_| "process_output_failed")?;
        if count == 0 {
            return Ok(out);
        }
        if count > limit.saturating_sub(out.len()) {
            return Err("process_output_too_large");
        }
        out.extend_from_slice(&bytes[..count]);
    }
}
pub async fn run(
    program: &str,
    args: &[String],
    input: &[u8],
    timeout: Duration,
    limit: usize,
) -> Result<Output, &'static str> {
    if input.len() > limit {
        return Err("process_input_too_large");
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn().map_err(|_| "process_unavailable")?;
    let group = Group(child.id().ok_or("process_unavailable")?);
    let mut stdin = child.stdin.take().ok_or("process_pipe_failed")?;
    let stdout = child.stdout.take().ok_or("process_pipe_failed")?;
    let stderr = child.stderr.take().ok_or("process_pipe_failed")?;
    let result = tokio::time::timeout(timeout, async {
        let write = async {
            stdin
                .write_all(input)
                .await
                .map_err(|_| "process_input_failed")?;
            drop(stdin);
            Ok(())
        };
        let wait = async { child.wait().await.map_err(|_| "process_wait_failed") };
        let (_, stdout, stderr, status) = tokio::try_join!(
            write,
            read(stdout, limit),
            read(stderr, limit.min(65536)),
            wait
        )?;
        Ok(Output {
            success: status.success(),
            stdout,
            stderr,
        })
    })
    .await
    .unwrap_or(Err("process_timed_out"));
    // Also terminate descendants retaining inherited pipes, including on cancellation.
    drop(group);
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}
use std::os::unix::process::CommandExt;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn full_duplex_and_deadlines() {
        let input = vec![42; 512 * 1024];
        assert_eq!(
            run("/bin/cat", &[], &input, Duration::from_secs(2), input.len())
                .await
                .unwrap()
                .stdout,
            input
        );
        let start = std::time::Instant::now();
        assert!(matches!(
            run(
                "/bin/sh",
                &["-c".into(), "sleep 20 & wait".into()],
                b"",
                Duration::from_millis(50),
                1024
            )
            .await,
            Err("process_timed_out")
        ));
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    #[tokio::test]
    async fn requests_overlap_and_cancellation_kills_the_process_group() {
        let started = std::time::Instant::now();
        let args = vec!["-c".into(), "sleep 0.1; printf ok".into()];
        let (a, b, c) = tokio::join!(
            run("/bin/sh", &args, b"", Duration::from_secs(2), 1024),
            run("/bin/sh", &args, b"", Duration::from_secs(2), 1024),
            run("/bin/sh", &args, b"", Duration::from_secs(2), 1024)
        );
        for result in [a, b, c] {
            assert_eq!(result.unwrap().stdout, b"ok");
        }
        assert!(started.elapsed() < Duration::from_millis(280));
        let marker = std::env::temp_dir().join(format!("omamail-cancel-{}", std::process::id()));
        let path = marker.to_str().unwrap().to_owned();
        let task = tokio::spawn(async move {
            run("python3", &["-c".into(), "import os,sys,time; open(sys.argv[1],'w').write(str(os.getpid())); time.sleep(30)".into(), path], b"", Duration::from_secs(30), 1024).await
        });
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid = std::fs::read_to_string(&marker)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        task.abort();
        let _ = task.await;
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "cancelled child must be gone"
        );
        std::fs::remove_file(marker).unwrap();
    }

    #[tokio::test]
    async fn output_is_bounded() {
        assert!(matches!(
            run(
                "/bin/sh",
                &["-c".into(), "while :; do printf 123456789; done".into()],
                b"",
                Duration::from_secs(2),
                64
            )
            .await,
            Err("process_output_too_large")
        ));
    }
}
