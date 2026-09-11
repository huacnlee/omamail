//! Interrupt the input wait when the peer can no longer receive responses.
use std::io::{self, BufReader, Read, Write};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub fn serve() -> io::Result<()> {
    let failed = Arc::new(AtomicBool::new(false));
    super::protocol::serve(
        BufReader::new(Input {
            failed: failed.clone(),
        }),
        Output {
            inner: io::stdout(),
            failed,
        },
    )
}

struct Input {
    failed: Arc<AtomicBool>,
}

impl Read for Input {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        loop {
            if self.failed.load(Ordering::Acquire) {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "output closed"));
            }
            let mut descriptor = libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN,
                revents: 0,
            };
            // The backend is the only stdin reader. Read the descriptor directly:
            // a buffered Stdin reader could contain bytes invisible to poll.
            let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if ready == 0 {
                continue;
            }
            // POLLHUP may accompany unread bytes. Read them before reporting EOF.
            // SAFETY: bytes supplies a valid writable buffer of the stated size.
            let count =
                unsafe { libc::read(libc::STDIN_FILENO, bytes.as_mut_ptr().cast(), bytes.len()) };
            if count >= 0 {
                return Ok(count as usize);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

struct Output {
    inner: io::Stdout,
    failed: Arc<AtomicBool>,
}

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let result = self.inner.write(bytes);
        if result
            .as_ref()
            .is_err_and(|e| e.kind() != io::ErrorKind::Interrupted)
            || matches!(result, Ok(0)) && !bytes.is_empty()
        {
            self.failed.store(true, Ordering::Release);
        }
        result
    }

    fn flush(&mut self) -> io::Result<()> {
        let result = self.inner.flush();
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result
    }
}
