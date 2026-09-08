use criterion::{black_box, Criterion, Throughput};
use serde::Deserialize;
use std::collections::HashSet;
use std::time::Duration;
use xearch_indexer::tokenizer::tokenize;

#[derive(Deserialize)]
struct Case {
    text: String,
}

fn main() -> color_eyre::Result<()> {
    let cases: Vec<Case> = include_str!("../../shared/fixtures/tokenizer-golden.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    let stopwords: HashSet<String> = HashSet::new();
    let mut criterion = Criterion::default()
        .sample_size(30)
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(2))
        .configure_from_args();
    {
        let mut group = criterion.benchmark_group("tokenizer");
        group.throughput(Throughput::Elements(u64::try_from(cases.len())?));
        group.bench_function("shared_goldens", |b| {
            b.iter(|| {
                for case in &cases {
                    black_box(tokenize(black_box(&case.text), &stopwords));
                }
            });
        });
        group.finish();
    }
    criterion.final_summary();
    drop(criterion);
    Ok(())
}
