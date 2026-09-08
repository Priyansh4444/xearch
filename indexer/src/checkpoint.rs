//! Crash-resume without dupes or gaps (RISKS O1).
//!
//! Checkpoint AFTER the Convex ack, atomically (write temp + rename). State is
//! tiny: file path + line offset per source file, plus the config hash that
//! produced it (a config change invalidates progress — O4).

use color_eyre::eyre::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Checkpoint {
    pub config_hash: String,
    /// file name -> next unprocessed line index
    pub offsets: std::collections::HashMap<String, u64>,
}

impl Checkpoint {
    /// # Errors
    ///
    /// Returns an error when the checkpoint exists but cannot be read or
    /// decoded as JSON.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }

    /// Atomic: write `.tmp` sibling, fsync, rename over.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or either filesystem operation
    /// fails.
    pub fn store(&self, path: &Path) -> Result<()> {
        let tmp: PathBuf = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}
