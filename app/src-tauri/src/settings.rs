/* The things that genuinely need an answer from the user, and nothing else.
 *
 * An earlier build had a Settings screen and it was deleted on sight, correctly: it asked where
 * downloads should go (there is one right answer, the Downloads folder) and for speed limits
 * (librqbit already saturates the line, so a limit is a way to make it worse). Those are knobs.
 *
 * What is here is not knobs. A proxy address, an indexer's URL and API key, a feed to watch —
 * these are facts only the user has. Nothing works without them and no default can be guessed.
 * That is the whole test for whether something belongs in this file.
 */

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// `socks5://[user:pass@]host:port`, or empty for a direct connection.
    pub socks_proxy: String,
    /// Torznab endpoints, the same ones Prowlarr and Sonarr speak to.
    pub indexers: Vec<Indexer>,
    /// Feeds polled in the background, adding whatever matches.
    pub feeds: Vec<Feed>,
    /// How many torrents may download at once. 0 means no queue at all.
    pub max_active: usize,
    /// When downloading is allowed. `None` means always.
    pub schedule: Option<Schedule>,
    /// Label per torrent, keyed by info hash — ids are reassigned on restart, hashes are not.
    pub labels: HashMap<String, String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Indexer {
    pub name: String,
    /// The Torznab API root, e.g. `http://192.168.1.5:9696/api/v1/indexer/3/newznab`.
    pub url: String,
    pub api_key: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Feed {
    pub name: String,
    pub url: String,
    /// Applied to everything this feed adds, so a series lands under one heading.
    pub label: String,
    /// Case-insensitive substring the title must contain. Empty takes everything.
    pub contains: String,
    /// GUIDs already added, so a feed that republishes an item does not download it twice.
    pub seen: Vec<String>,
}

/* Stored as minutes past UTC midnight, converted by the frontend when it is set.
 *
 * The alternative was chrono's Local::now(), and on Android that is a trap: the timezone lives
 * in a system property rather than /etc/localtime or $TZ, so the crate that reads it has to
 * special-case the platform and does not always get it right. The webview knows the local time
 * exactly and for free. So the UI does the conversion once, at the moment the user picks the
 * hours, and Rust only ever compares two UTC numbers.
 *
 * The cost is that a schedule set in summer drifts by an hour in winter. Re-picking the hours
 * fixes it, and that is a better failure than a schedule that silently never fires.
 */
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub from_minute_utc: u32,
    pub to_minute_utc: u32,
}

impl Schedule {
    /// Windows that wrap past midnight are normal — "overnight" is the obvious use for this.
    pub fn allows(&self, minute_utc: u32) -> bool {
        if self.from_minute_utc == self.to_minute_utc {
            return true;
        }
        if self.from_minute_utc < self.to_minute_utc {
            minute_utc >= self.from_minute_utc && minute_utc < self.to_minute_utc
        } else {
            minute_utc >= self.from_minute_utc || minute_utc < self.to_minute_utc
        }
    }
}

/// Minutes past UTC midnight, straight off the system clock. No date maths, no dependency.
pub fn minute_utc_now() -> u32 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ((secs % 86_400) / 60) as u32
}

fn path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

/// Missing or corrupt reads as empty. A settings file is never worth failing a launch over.
pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, settings: &Settings) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(path(dir), serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_window_is_a_range() {
        let s = Schedule { from_minute_utc: 60, to_minute_utc: 120 };
        assert!(!s.allows(59));
        assert!(s.allows(60));
        assert!(s.allows(119));
        assert!(!s.allows(120));
    }

    #[test]
    fn an_overnight_window_wraps() {
        // 23:00 to 06:00 — the case the obvious implementation gets wrong.
        let s = Schedule { from_minute_utc: 23 * 60, to_minute_utc: 6 * 60 };
        assert!(s.allows(23 * 60));
        assert!(s.allows(0));
        assert!(s.allows(5 * 60));
        assert!(!s.allows(6 * 60));
        assert!(!s.allows(12 * 60));
    }

    #[test]
    fn an_empty_window_means_always() {
        let s = Schedule { from_minute_utc: 0, to_minute_utc: 0 };
        assert!(s.allows(0));
        assert!(s.allows(720));
    }
}
