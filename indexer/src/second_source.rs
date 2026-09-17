//! Second fast source of truth — embedded Tantivy, on this machine.
//!
//! Convex remains the primary source of truth. This module is an ISOLATED,
//! optional lane: it reads the same ingress JSONL the pipeline already reads
//! (READ-ONLY) and builds a local Tantivy inverted index — no JVM, no server
//! process, no network hop. The index lives in a directory (memory-mapped
//! readers page it in on demand), and `serve-second` answers queries from it.
//! It never writes to Convex and no existing pipeline path (prepare / upload /
//! fold / refresh) depends on anything here.
//!
//! Subcommands: `index-second` (build the Tantivy index), `serve-second`
//! (axum proxy on 127.0.0.1 over the local index). See docs/SECOND-SOURCE.md.

use crate::model::IngressRecord;
use color_eyre::eyre::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::ops::Bound;
use std::path::{Path, PathBuf};
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, Occur, QueryParser, RangeQuery, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, SchemaBuilder, FAST, INDEXED, STORED, STRING, TEXT,
};
use tantivy::{Index, IndexReader, ReloadPolicy, TantivyDocument, Term};

/// Default index directory (`SECOND_SOURCE_INDEX_DIR` overrides, e.g. tests).
pub const INDEX_DIR_DEFAULT: &str = "./second-source-index";
/// Proxied local interface for the web lane (`--port` overrides).
pub const PROXY_DEFAULT_PORT: u16 = 9201;
/// Index-writer heap budget (bytes). Modest: the machine may host the live pipeline.
pub const WRITER_HEAP_BYTES: usize = 100_000_000;
/// Writer threads for the build. Modest: the machine may host the live pipeline.
pub const WRITER_THREADS: usize = 2;
/// Max hits per query (matches the Convex rerank window).
pub const MAX_LIMIT: usize = 200;

/// Index directory for this process (tests point it at a temp dir).
///
/// # Errors
///
/// Never: the default always parses.
pub fn index_dir() -> Result<PathBuf> {
    Ok(PathBuf::from(
        std::env::var("SECOND_SOURCE_INDEX_DIR").unwrap_or_else(|_| INDEX_DIR_DEFAULT.to_owned()),
    ))
}

/// Tantivy schema for one tweet document.
pub struct LaneSchema {
    pub schema: Schema,
    pub text: Field,
    pub tweet_id: Field,
    pub author_id: Field,
    pub author_handle: Field,
    pub created_at: Field,
}

impl LaneSchema {
    /// Build the schema: full-text `text` (BM25), keyword ids/handles,
    /// range-capable `createdAt`. `text` is STORED so the lane can render
    /// results; STORED fields load per hit, not into resident memory.
    #[must_use]
    pub fn build() -> Self {
        let mut builder = SchemaBuilder::new();
        let text = builder.add_text_field("text", TEXT | STORED);
        let tweet_id = builder.add_text_field("tweet_id", STRING | STORED);
        let author_id = builder.add_text_field("author_id", STRING | STORED);
        let author_handle = builder.add_text_field("author_handle", STRING | STORED);
        let created_at = builder.add_u64_field("created_at", FAST | STORED | INDEXED);
        Self {
            schema: builder.build(),
            text,
            tweet_id,
            author_id,
            author_handle,
            created_at,
        }
    }
}

/// Open the index directory (creating it), with memory-mapped readers so the
/// OS pages index data in and out on demand instead of pinning it in RSS.
///
/// # Errors
///
/// Fails when the directory cannot be created or opened.
pub fn open_index(dir: &Path, lane: &LaneSchema) -> Result<Index> {
    std::fs::create_dir_all(dir).wrap_err_with(|| format!("create {}", dir.display()))?;
    let mmap = MmapDirectory::open(dir).wrap_err_with(|| format!("open {}", dir.display()))?;
    Index::open_or_create(mmap, lane.schema.clone())
        .wrap_err_with(|| format!("open {}", dir.display()))
}

/// Progress counters from an index build.
pub struct BuildStats {
    pub tweets: u64,
    pub authors: u64,
    pub malformed: u64,
}

/// Read ingress JSONL files (READ-ONLY) and index tweets locally.
/// Rebuilds are idempotent: each tweet is deleted by `tweet_id` first
/// (same doc count, no duplicates).
///
/// # Errors
///
/// Fails on unreadable files or index errors. A malformed line is counted to
/// stderr, never a crash: same failure policy as the pipeline.
pub fn build_from_files(dir: &Path, files: &[PathBuf]) -> Result<BuildStats> {
    let lane = LaneSchema::build();
    let index = open_index(dir, &lane)?;
    let mut writer = index
        .writer_with_num_threads(WRITER_THREADS, WRITER_HEAP_BYTES)
        .wrap_err("tantivy writer")?;
    let mut author_map: HashMap<String, String> = HashMap::new();
    let mut stats = BuildStats {
        tweets: 0,
        authors: 0,
        malformed: 0,
    };
    for file in files {
        let reader = BufReader::new(
            std::fs::File::open(file).wrap_err_with(|| format!("open {}", file.display()))?,
        );
        for maybe_text in reader.lines() {
            let text = maybe_text.wrap_err("read line")?;
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<IngressRecord>(trimmed) {
                Ok(IngressRecord::Author(author)) => {
                    author_map.insert(author.id.0.clone(), author.handle.0.clone());
                    stats.authors = stats.authors.saturating_add(1);
                }
                Ok(IngressRecord::Tweet(tweet)) => {
                    let handle = author_map
                        .get(tweet.author_id.as_str())
                        .cloned()
                        .unwrap_or_default();
                    let id_term = Term::from_field_text(lane.tweet_id, tweet.id.as_str());
                    writer.delete_term(id_term);
                    let mut doc = TantivyDocument::default();
                    doc.add_text(lane.text, tweet.text);
                    doc.add_text(lane.tweet_id, tweet.id.as_str());
                    doc.add_text(lane.author_id, tweet.author_id.as_str());
                    doc.add_text(lane.author_handle, handle);
                    doc.add_u64(
                        lane.created_at,
                        u64::try_from(tweet.created_at).unwrap_or(u64::MAX),
                    );
                    writer.add_document(doc).wrap_err("add tweet doc")?;
                    stats.tweets = stats.tweets.saturating_add(1);
                }
                Err(err) => {
                    stats.malformed = stats.malformed.saturating_add(1);
                    eprintln!("malformed ingress line: {err}");
                }
            }
        }
    }
    writer.commit().wrap_err("commit index")?;
    Ok(stats)
}

/// Open a reader with on-commit reloads for serving.
///
/// # Errors
///
/// Fails when the index directory cannot be opened.
pub fn open_reader(dir: &Path, lane: &LaneSchema) -> Result<(Index, IndexReader)> {
    let index = open_index(dir, lane)?;
    let reader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()
        .wrap_err("tantivy reader")?;
    Ok((index, reader))
}

/// Query parameters accepted by the HTTP lane.
#[derive(Debug, Default, Deserialize)]
pub struct SearchParams {
    /// Free-text query (BM25 over tweet text, terms `AND`ed).
    pub q: Option<String>,
    /// Author handle OR author id filter (keyword exact match).
    pub author: Option<String>,
    /// Unix ms lower bound (inclusive).
    pub since: Option<u64>,
    /// Unix ms upper bound (inclusive).
    pub until: Option<u64>,
    /// Max hits (clamped to the rerank window).
    pub limit: Option<usize>,
}

/// Execute `params` against the local index, returning the stable proxy
/// response (same shape as the Convex lane so a web lane can point at either).
///
/// # Errors
///
/// Fails on empty queries, `since > until`, or an index error.
pub fn serve_query(
    index: &Index,
    reader: &IndexReader,
    lane: &LaneSchema,
    params: &SearchParams,
) -> Result<Value> {
    let limit = params.limit.unwrap_or(20).clamp(1, MAX_LIMIT);
    let searcher = reader.searcher();
    let mut clauses: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();
    if let Some(q) = params.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let mut parser = QueryParser::for_index(index, vec![lane.text]);
        parser.set_conjunction_by_default();
        let text_query = parser
            .parse_query(q)
            .wrap_err_with(|| format!("parse query {q:?}"))?;
        clauses.push((Occur::Must, text_query));
    }
    if let Some(author) = params
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        let handle_q: Box<dyn tantivy::query::Query> = Box::new(TermQuery::new(
            Term::from_field_text(lane.author_handle, author),
            IndexRecordOption::Basic,
        ));
        let id_q: Box<dyn tantivy::query::Query> = Box::new(TermQuery::new(
            Term::from_field_text(lane.author_id, author),
            IndexRecordOption::Basic,
        ));
        let author_q: Box<dyn tantivy::query::Query> = Box::new(BooleanQuery::new(vec![
            (Occur::Should, handle_q),
            (Occur::Should, id_q),
        ]));
        clauses.push((Occur::Must, author_q));
    }
    match (params.since, params.until) {
        (Some(since), Some(until)) if since > until => bail!("since must be <= until"),
        (since, until) => {
            if since.is_some() || until.is_some() {
                let lower = since.map_or(Bound::Unbounded, |v| {
                    Bound::Included(Term::from_field_u64(lane.created_at, v))
                });
                let upper = until.map_or(Bound::Unbounded, |v| {
                    Bound::Included(Term::from_field_u64(lane.created_at, v))
                });
                let range_q: Box<dyn tantivy::query::Query> =
                    Box::new(RangeQuery::new(lower, upper));
                clauses.push((Occur::Must, range_q));
            }
        }
    }
    if clauses.is_empty() {
        bail!("empty query: provide q, author, or a time range");
    }
    let query = BooleanQuery::new(clauses);
    let mut multi = tantivy::collector::MultiCollector::new();
    let top_handle = multi.add_collector(TopDocs::with_limit(limit).order_by_score());
    let count_handle = multi.add_collector(tantivy::collector::Count);
    let mut fruits = searcher.search(&query, &multi).wrap_err("tantivy search")?;
    let total_hits: usize = count_handle.extract(&mut fruits);
    let top_docs: Vec<(f32, tantivy::DocAddress)> = top_handle.extract(&mut fruits);
    let mut results = Vec::with_capacity(top_docs.len());
    for (score, addr) in top_docs {
        let doc: TantivyDocument = searcher.doc(addr).wrap_err("read doc")?;
        let get = |f: Field| -> Value {
            doc.get_first(f).map_or(Value::Null, |v| {
                let owned: tantivy::schema::OwnedValue = v.into();
                match owned {
                    tantivy::schema::OwnedValue::Str(s) => Value::String(s),
                    tantivy::schema::OwnedValue::U64(n) => Value::from(n),
                    other => Value::String(format!("{other:?}")),
                }
            })
        };
        results.push(json!({
            "tweetId": get(lane.tweet_id),
            "text": get(lane.text),
            "authorHandle": get(lane.author_handle),
            "createdAt": get(lane.created_at),
            "score": score,
        }));
    }
    Ok(json!({
        "total": total_hits,
        "count": results.len(),
        "results": results,
        "source": "second fast source of truth (embedded Tantivy on this machine); Convex remains the primary source of truth",
    }))
}

/// Serve GET /search and GET /stats on 127.0.0.1 — one stable local interface
/// so the web lane never needs to know index internals.
///
/// # Errors
///
/// Fails when the index directory cannot be opened or the port is taken.
pub async fn serve(dir: &Path, port: u16) -> Result<()> {
    use axum::extract::{Query, State};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::{Json, Router};
    use std::sync::Arc;

    struct Lane {
        index: Index,
        reader: IndexReader,
        schema: LaneSchema,
    }
    let schema = LaneSchema::build();
    let (index, reader) = open_reader(dir, &schema)?;
    let lane = Arc::new(Lane {
        index,
        reader,
        schema,
    });
    let app = Router::new()
        .route(
            "/search",
            get(
                |State(lane): State<Arc<Lane>>,
                 Query(params): Query<SearchParams>| async move {
                    match serve_query(&lane.index, &lane.reader, &lane.schema, &params) {
                        Ok(value) => Json(value).into_response(),
                        Err(err) => (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(json!({"error": err.to_string()})),
                        )
                            .into_response(),
                    }
                },
            ),
        )
        .route(
            "/stats",
            get(|State(lane): State<Arc<Lane>>| async move {
                let count = lane
                    .reader
                    .searcher()
                    .num_docs();
                Json(json!({
                    "docs": count,
                    "source": "second fast source of truth (embedded Tantivy on this machine); Convex remains the primary source of truth",
                }))
            }),
        )
        .with_state(lane);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .wrap_err_with(|| format!("bind {addr}"))?;
    eprintln!("second fast source of truth (embedded Tantivy) on http://{addr} — Convex remains the primary source of truth");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .wrap_err("serve")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sample_records(path: &Path) {
        let mut f = std::fs::File::create(path).unwrap();
        writeln!(
            f,
            r#"{{"kind":"author","id":"7","handle":"theo","displayName":"Theo","createdAt":1700000000000,"followerCount":10,"followingCount":0,"verified":false}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"kind":"tweet","id":"9","text":"apple tree pricing","authorId":"7","createdAt":1700000000000,"metrics":{{"likes":1,"retweets":0,"quotes":0,"replies":0}},"metricsAt":1700000100000,"media":[],"quotedTweetId":null,"retweetOfTweetId":null,"inReplyToTweetId":null}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"kind":"tweet","id":"10","text":"rust systems talk","authorId":"7","createdAt":1700000200000,"metrics":{{"likes":2,"retweets":0,"quotes":0,"replies":0}},"metricsAt":1700000300000,"media":[],"quotedTweetId":null,"retweetOfTweetId":null,"inReplyToTweetId":null}}"#
        )
        .unwrap();
    }

    #[test]
    fn tantivy_round_trip_and_idempotent_rebuild() {
        let dir = std::env::temp_dir().join(format!("xearch-lane-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let idx = dir.join("index");
        let recs = dir.join("recs.jsonl");
        sample_records(&recs);
        let stats = build_from_files(&idx, std::slice::from_ref(&recs)).unwrap();
        assert_eq!(stats.tweets, 2);
        let lane = LaneSchema::build();
        let (index, reader) = open_reader(&idx, &lane).unwrap();
        let ask = |q: Option<&str>| {
            serve_query(
                &index,
                &reader,
                &lane,
                &SearchParams {
                    q: q.map(str::to_owned),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        assert_eq!(ask(Some("pricing"))["results"].as_array().unwrap().len(), 1);
        assert_eq!(ask(Some("rust"))["results"][0]["tweetId"], json!("10"));
        // Author filter by handle.
        let by_author = serve_query(
            &index,
            &reader,
            &lane,
            &SearchParams {
                author: Some("theo".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_author["results"].as_array().unwrap().len(), 2);
        // Rebuild over the same files: same doc count, no duplicates.
        let _ = build_from_files(&idx, std::slice::from_ref(&recs)).unwrap();
        reader.reload().unwrap();
        let after = serve_query(
            &index,
            &reader,
            &lane,
            &SearchParams {
                author: Some("theo".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after["results"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
