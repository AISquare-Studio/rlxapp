//! The rlx home the engine adapter points rlxd at (its `AISQUARE_HOME`).
//!
//! The app never reads or writes the owner's real rlx home. Dev builds use a sandbox
//! (`~/.rlx-sandbox`), and a configured home is refused if it IS the real home, or lies
//! inside it, however it's spelled: `~`, `..`, a trailing `/.`, a symlink, or different
//! letter case (APFS and NTFS are case-insensitive by default). The engine adapter must take
//! its home from [`resolve_engine_home`]; the UI's check (src/engine/adapter/home.ts) is only
//! a friendly first pass.

use std::fmt;
use std::path::{Component, Path, PathBuf};

/// The sandboxed rlx 0.10.3 home for app development.
pub const SANDBOX_HOME: &str = "~/.rlx-sandbox";

/// The owner's real rlx home directory name, spelled so a grep finds only this guard.
const REAL_HOME_DIR: &str = concat!(".", "aisq", "uare");

#[derive(Debug, PartialEq, Eq)]
pub enum HomeError {
    /// The path is the real rlx home, or inside it.
    RealHome,
    /// Neither absolute nor `~`-relative.
    NotAbsolute,
}

impl fmt::Display for HomeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RealHome => write!(
                f,
                "that is the real rlx home, or inside it; use a sandbox such as {SANDBOX_HOME}"
            ),
            Self::NotAbsolute => write!(f, "use an absolute path, or one that starts with ~"),
        }
    }
}

impl std::error::Error for HomeError {}

/// Removes `.` and resolves `..` without touching the disk.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The canonical form of the longest existing ancestor (symlinks resolved), plus the rest.
fn canonical(path: &Path) -> PathBuf {
    let path = lexical(path);
    let mut existing = path.as_path();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = existing.canonicalize() {
            return rest
                .iter()
                .rev()
                .fold(real, |acc: PathBuf, part| acc.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_owned());
                existing = parent;
            }
            _ => return path,
        }
    }
}

/// Lower-cased path components, for a case-insensitive comparison.
fn folded(path: &Path) -> Vec<String> {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// The home to give rlxd: the configured one if it's allowed, else the sandbox. `user_home` is
/// the OS user's home directory (`~`).
pub fn resolve_engine_home(
    configured: Option<&str>,
    user_home: &Path,
) -> Result<PathBuf, HomeError> {
    let value = configured
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(SANDBOX_HOME);
    // A path that names the real home anywhere is refused first, whatever the OS thinks of
    // its form ('/x/<real home>' isn't absolute on Windows, but it's never allowed).
    let names_real_home = value
        .split(['/', '\\'])
        .any(|part| part.to_lowercase() == REAL_HOME_DIR);
    if names_real_home {
        return Err(HomeError::RealHome);
    }
    let expanded = if value == "~" {
        user_home.to_path_buf()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        user_home.join(rest)
    } else if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        return Err(HomeError::NotAbsolute);
    };
    let candidate = canonical(&expanded);
    let real = canonical(&user_home.join(REAL_HOME_DIR));
    let (candidate_parts, real_parts) = (folded(&candidate), folded(&real));
    let inside_real = candidate_parts.starts_with(&real_parts);
    let names_real = candidate_parts.iter().any(|part| *part == REAL_HOME_DIR);
    if inside_real || names_real {
        return Err(HomeError::RealHome);
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A throwaway user home with a real rlx home in it and a symlink pointing at it.
    struct FakeHome(PathBuf);

    impl FakeHome {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("rlx-home-guard-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join(REAL_HOME_DIR).join("sub")).unwrap();
            fs::create_dir_all(dir.join("projects")).unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(dir.join(REAL_HOME_DIR), dir.join("alias")).unwrap();
            Self(dir)
        }
    }

    impl Drop for FakeHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn defaults_to_the_sandbox() {
        let home = FakeHome::new("default");
        let resolved = resolve_engine_home(None, &home.0).unwrap();
        assert!(resolved.ends_with(".rlx-sandbox"), "{resolved:?}");
        assert_eq!(resolve_engine_home(Some("  "), &home.0).unwrap(), resolved);
    }

    #[test]
    fn refuses_the_real_home_however_it_is_spelled() {
        let home = FakeHome::new("refuse");
        let real = REAL_HOME_DIR;
        let upper = real.to_uppercase();
        let absolute = home.0.join(real).display().to_string();
        let mut spellings = vec![
            format!("~/{real}"),
            format!("~/{real}/"),
            format!("~/{real}/."),
            format!("~/{real}/./"),
            format!("~/{upper}"),
            format!("~/{real}/sub"),
            format!("~/{real}/sub/deeper/not-yet"),
            format!("~/projects/../{real}"),
            absolute.clone(),
            format!("{absolute}/sub"),
            format!("/elsewhere/{real}"),
            format!("C:\\elsewhere\\{upper}\\sub"),
        ];
        if cfg!(unix) {
            spellings.push("~/alias".to_owned());
            spellings.push("~/alias/sub".to_owned());
        }
        for spelling in spellings {
            assert_eq!(
                resolve_engine_home(Some(&spelling), &home.0),
                Err(HomeError::RealHome),
                "{spelling}"
            );
        }
    }

    #[test]
    fn allows_a_sandbox_and_refuses_relative_paths() {
        let home = FakeHome::new("allow");
        let resolved = resolve_engine_home(Some("~/rlx-dev"), &home.0).unwrap();
        assert!(resolved.ends_with("rlx-dev"));
        assert_eq!(
            resolve_engine_home(Some("relative/path"), &home.0),
            Err(HomeError::NotAbsolute)
        );
    }
}
