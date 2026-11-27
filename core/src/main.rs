fn main() {
    #[cfg(windows)]
    {
        // Windows reserves only 1 MiB for the executable's initial thread.
        // The shared CLI/backend dispatch futures need the same stack budget
        // as the Unix entry point, including in unoptimized native test builds.
        let result = std::thread::Builder::new()
            .name("omamail-main".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(omamail::cli::run)
            .expect("start backend entry thread")
            .join();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
    #[cfg(not(windows))]
    omamail::cli::run();
}
