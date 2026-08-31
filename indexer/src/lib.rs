//! Xearch offline indexer. Stateless compute: every byte of durable state lives in
//! Convex (DESIGN §9); this process can die at any point and resume from checkpoint
//! (RISKS O1). Pure logic in modules, I/O at the edges (main.rs).

pub mod checkpoint;
pub mod convex_api;
pub mod model;
pub mod pipeline;
pub mod tokenizer;
pub mod tweepcred;
