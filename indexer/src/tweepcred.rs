//! Tweepcred-style authority (DESIGN §6.2).
//!
//! This is weighted `PageRank` with Twitter's hyperparameters, post-adjusted
//! by follower/following ratio. It runs in `refresh` mode.

use std::collections::HashMap;

pub const JUMP_PROB: f64 = 0.1;
pub const MAX_ITERATIONS: u32 = 20;
pub const CONVERGENCE_EPS: f64 = 0.001;

/// Edge weights mirror the engagement formula (quotes highest — DESIGN §6.1).
pub const W_QUOTE: f64 = 3.0;
pub const W_RETWEET: f64 = 2.0;
pub const W_REPLY: f64 = 1.5;
pub const W_MENTION: f64 = 1.0;

fn usize_as_f64(value: usize) -> f64 {
    let value = u64::try_from(value).unwrap_or(u64::MAX);
    let high = u32::try_from(value >> 32).unwrap_or(u32::MAX);
    let low = u32::try_from(value & u64::from(u32::MAX)).unwrap_or(0);
    f64::from(high).mul_add(4_294_967_296.0, f64::from(low))
}

pub struct InteractionGraph {
    /// src author -> [(dst author, weight)]; built from quoted/retweetOf/inReplyTo
    /// edges + mention entities across the corpus snapshot.
    pub edges: HashMap<String, Vec<(String, f64)>>,
    pub follower_ratio: HashMap<String, f64>, // followers / max(following, 1)
}

/// Power iteration until convergence or `MAX_ITERATIONS`. At hackathon scale
/// (<=100k authors) this is seconds of CPU — a loop, not infrastructure.
#[must_use]
pub fn tweepcred(graph: &InteractionGraph) -> HashMap<String, f64> {
    let nodes: Vec<&String> = graph
        .edges
        .keys()
        .chain(graph.edges.values().flatten().map(|(node, _)| node))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if nodes.is_empty() {
        return HashMap::new();
    }
    let initial = 1.0 / usize_as_f64(nodes.len());
    let mut scores: HashMap<String, f64> = nodes
        .iter()
        .map(|node| ((*node).clone(), initial))
        .collect();
    for _ in 0..MAX_ITERATIONS {
        let mut next: HashMap<String, f64> = nodes
            .iter()
            .map(|node| ((*node).clone(), JUMP_PROB * initial))
            .collect();
        for (source, edges) in &graph.edges {
            let mass = scores.get(source).copied().unwrap_or(0.0);
            let total_weight: f64 = edges.iter().map(|(_, weight)| *weight).sum();
            if total_weight <= 0.0 {
                continue;
            }
            for (target, weight) in edges {
                if let Some(value) = next.get_mut(target) {
                    *value += (1.0 - JUMP_PROB) * mass * weight / total_weight;
                }
            }
        }
        let delta: f64 = nodes
            .iter()
            .map(|node| {
                (next.get(*node).copied().unwrap_or(0.0)
                    - scores.get(*node).copied().unwrap_or(0.0))
                .abs()
            })
            .sum();
        scores = next;
        if delta < CONVERGENCE_EPS {
            break;
        }
    }
    for (node, score) in &mut scores {
        let ratio = graph.follower_ratio.get(node).copied().unwrap_or(1.0);
        *score *= ratio.clamp(0.1, 1.0);
    }
    scores
}
