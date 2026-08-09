/* Settings, and the ability to put them back.
 *
 * Three fields, kept as JSON next to the session state. Everything else a torrent client
 * usually exposes — port ranges, DHT toggles, peer counts — is a knob whose right value is
 * "leave it alone", and a settings screen full of those is how people break their own client.
 */
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Where downloads go. Empty means "wherever the app decided", which is the Downloads folder.
    pub folder: String,
    /// KB/s ceilings. 0 is unlimited, which is what both start as.
    pub download_kbps: u32,
    pub upload_kbps: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            folder: String::new(),
            download_kbps: 0,
            upload_kbps: 0,
        }
    }
}

impl Config {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("settings.json")
    }

    /// Never fails: a missing or corrupt file means defaults, because refusing to start over a
    /// settings file is a worse outcome than ignoring it.
    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(Self::path(dir))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::write(Self::path(dir), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// KB/s as the limiter wants it: bytes per second, and None for "no limit".
    pub fn bps(kbps: u32) -> Option<NonZeroU32> {
        NonZeroU32::new(kbps.saturating_mul(1024))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_means_unlimited() {
        assert_eq!(Config::bps(0), None);
        assert_eq!(Config::bps(1).unwrap().get(), 1024);
        // Saturating, so a nonsense value clamps instead of wrapping to a tiny limit.
        assert_eq!(Config::bps(u32::MAX).unwrap().get(), u32::MAX);
    }

    #[test]
    fn a_corrupt_settings_file_reads_as_defaults() {
        let dir = std::env::temp_dir().join(format!("flai-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(Config::path(&dir), "{ not json").unwrap();
        assert_eq!(Config::load(&dir), Config::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn round_trips_and_resets() {
        let dir = std::env::temp_dir().join(format!("flai-cfg2-{}", std::process::id()));
        let saved = Config {
            folder: "/tmp/somewhere".into(),
            download_kbps: 500,
            upload_kbps: 50,
        };
        saved.save(&dir).unwrap();
        assert_eq!(Config::load(&dir), saved);

        Config::default().save(&dir).unwrap();
        assert_eq!(Config::load(&dir), Config::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A settings file written by an older build must not stop the app reading the rest.
    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let dir = std::env::temp_dir().join(format!("flai-cfg3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            Config::path(&dir),
            r#"{"folder":"/x","somethingRemoved":true}"#,
        )
        .unwrap();
        let loaded = Config::load(&dir);
        assert_eq!(loaded.folder, "/x");
        assert_eq!(loaded.download_kbps, 0, "missing field falls back to default");
        std::fs::remove_dir_all(&dir).ok();
    }
}
