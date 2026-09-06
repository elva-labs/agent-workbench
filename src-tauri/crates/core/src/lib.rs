//! Agent Workbench core.
//!
//! Every pty, git query, filesystem watch, session index and hook lives here,
//! with no window attached: the desktop app wraps it in Tauri commands, the
//! remote daemon in a stream of JSON lines, and both hear from it through a
//! [`Sink`]. Rust owns state; whatever is on the other side owns pixels.

pub mod activity;
pub mod adapter;
pub mod api;
pub mod codex;
pub mod cwd;
pub mod env;
pub mod events;
pub mod git;
pub mod hook;
pub mod project;
pub mod protocol;
pub mod pty;
pub mod shell;
pub mod transcripts;
pub mod watch;

pub use api::{Core, DetectReport, DirEntry, SessionIdentified, Spawned, SESSION_IDENTIFIED};
pub use events::{Output, Sink};
