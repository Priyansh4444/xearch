//! Tweepcred-style authority (DESIGN §6.2): weighted PageRank over the interaction
//! graph, Twitter's own hyperparameters (jump 0.1, <=20 iterations, eps 0.001),
//! post-adjusted by follower/following ratio. Runs in `refresh` mode; output goes
//! to ingest::upsertAuthority (serving-side blends the follower floor, K3).

use std::collections::HashMap;

pub const JUMP_PROB: f64 = 0.1;
pub const MAX_ITERATIONS: u32 = 20;
pub const CONVERGENCE_EPS: f64 = 0.001;

/// Edge weights mirror the engagement formula (quotes highest — DESIGN §6.1).
pub const W_QUOTE: f64 = 3.0;
pub const W_RETWEET: f64 = 2.0;
pub const W_REPLY: f64 = 1.5;
pub const W_MENTION: f64 = 1.0;

pub struct InteractionGraph {
    /// src author -> [(dst author, weight)]; built from quoted/retweetOf/inReplyTo
    /// edges + mention entities across the corpus snapshot.
    pub edges: HashMap<String, Vec<(String, f64)>>,
    pub follower_ratio: HashMap<String, f64>, // followers / max(following, 1)
}

/// Power iteration until convergence or MAX_ITERATIONS. At hackathon scale
/// (<=100k authors) this is seconds of CPU — a loop, not infrastructure.
pub fn tweepcred(graph: &InteractionGraph) -> HashMap<String, f64> {
    // TODO(implement):
    //   init: uniform mass. iterate: mass' = jump/N + (1-jump) * Σ in-edges,
    //   weighted; L1-normalize; stop at eps. post-adjust: dampen scores of nodes
    //   with follower_ratio << 1 (follow-farm deflation, per Tweepcred README).
    let _ = graph;
    todo!("tweepcred power iteration")
}
