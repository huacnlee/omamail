use std::process::Command;

#[test]
fn cli_reads_only_bounded_regular_files_without_writing() {
    let temp = Command::new("mktemp").arg("-d").output().unwrap();
    assert!(temp.status.success());
    let root = std::path::PathBuf::from(String::from_utf8(temp.stdout).unwrap().trim());
    let directory = root.join("omamail");
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("accounts.json");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(["accounts", "list"])
            .env("XDG_CONFIG_HOME", &root)
            .output()
            .unwrap()
    };
    assert!(run().status.success());
    assert!(!path.exists());
    let valid = b"{\"version\":1,\"accounts\":[{\"email\":\"a@example.org\",\"clientSecret\":\"synthetic-secret\"}]}";
    std::fs::write(&path, valid).unwrap();
    let output = run();
    assert!(output.status.success());
    assert!(
        !String::from_utf8(output.stdout)
            .unwrap()
            .contains("synthetic-secret")
    );
    assert_eq!(std::fs::read(&path).unwrap(), valid);
    std::fs::write(&path, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(!run().status.success());
    std::fs::remove_file(&path).unwrap();
    let target = root.join("credential");
    std::fs::write(&target, valid).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(!run().status.success());
    assert_eq!(std::fs::read(&target).unwrap(), valid);
    std::fs::remove_file(&path).unwrap();
    assert!(
        Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    assert!(!run().status.success());
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(target).unwrap();
    std::fs::remove_dir(directory).unwrap();
    std::fs::remove_dir(root).unwrap();
}
