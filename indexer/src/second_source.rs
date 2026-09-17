//! Second fast source of truth — a self-hosted Elasticsearch/Lucene lane.
//!
//! Convex remains the primary source of truth. This module is an ISOLATED,
//! optional lane: it reads the same ingress JSONL the pipeline already reads
//! and pushes it into a self-hosted Elasticsearch index, then serves local
//! queries through a thin proxy. It never writes to Convex and no existing
//! pipeline path (prepare / upload / fold / refresh) depends on anything here.
//!
//! Subcommands: `index-second` (bulk-push corpus to ES), `serve-second`
//! (axum proxy on 127.0.0.1). See docs/SECOND-SOURCE.md.

use crate::model::IngressRecord;
use color_eyre::eyre::{bail, Context, Result};
use elasticsearch::{BulkIndexOperation, BulkOperation, Elasticsearch};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::Duration;

/// Default index name (`SECOND_SOURCE_INDEX` overrides, e.g. for tests).
pub const INDEX_DEFAULT: &str = "xearch_tweets_v1";
/// Default ES endpoint (`ELASTICSEARCH_URL` overrides).
pub const DEFAULT_URL: &str = "http://127.0.0.1:9200";
/// Proxied local interface for the web lane (`--port` overrides).
pub const PROXY_DEFAULT_PORT: u16 = 9201;
/// Bulk batch size (docs). Modest: the machine may host the live pipeline.
pub const BULK_BATCH: usize = 1_000;

/// Index name for this process (tests set `SECOND_SOURCE_INDEX`).
#[must_use]
pub fn index_name() -> &'static str {
    static CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        Box::leak(
            std::env::var("SECOND_SOURCE_INDEX")
                .unwrap_or_else(|_| INDEX_DEFAULT.to_owned())
                .into_boxed_str(),
        )
    })
}

/// ES endpoint/API-key config shared by both subcommands.
pub struct EsConfig {
    pub url: String,
    pub api_key: Option<String>,
}

impl EsConfig {
    /// From `ELASTICSEARCH_URL` / `ELASTICSEARCH_API_KEY` /
    /// `ELASTICSEARCH_RETRIES`.
    ///
    /// # Errors
    ///
    /// Never: env fallbacks keep this infallible.
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            url: std::env::var("ELASTICSEARCH_URL").unwrap_or_else(|_| DEFAULT_URL.to_owned()),
            api_key: std::env::var("ELASTICSEARCH_API_KEY").ok(),
        })
    }

    /// Build the HTTP client.
    ///
    /// # Errors
    ///
    /// Fails when the transport cannot be built (bad URL, TLS).
    pub fn transport(&self) -> Result<Elasticsearch> {
        let pool = elasticsearch::http::transport::SingleNodeConnectionPool::new(
            self.url.parse().wrap_err("parse ELASTICSEARCH_URL")?,
        );
        let mut builder = elasticsearch::http::transport::TransportBuilder::new(pool);
        if let Some(key) = &self.api_key {
            builder = builder.auth(elasticsearch::auth::Credentials::EncodedApiKey(key.clone()));
        }
        let transport = builder
            .timeout(default_timeout())
            .build()
            .wrap_err("build ES transport")?;
        Ok(Elasticsearch::new(transport))
    }
}

#[must_use]
pub(crate) const fn default_timeout() -> Duration {
    Duration::from_secs(30)
}

/// Create the index with the mapping (idempotent: `resource_already_exists` is
/// fine). english analyzer = Lucene tokenized + stemmed.
async fn ensure_index(client: &Elasticsearch) -> Result<()> {
    let name = index_name();
    let exists = client
        .indices()
        .exists(elasticsearch::indices::IndicesExistsParts::Index(&[name]))
        .send()
        .await
        .wrap_err("ES exists check")?;
    if exists.status_code().is_success() {
        return Ok(());
    }
    let resp = client
        .indices()
        .create(elasticsearch::indices::IndicesCreateParts::Index(name))
        .body(json!({
            "settings": {
                "number_of_shards": 1,
                "number_of_replicas": 0,
                "refresh_interval": "1s"
            },
            "mappings": {
                "properties": {
                    "text": {"type": "text", "analyzer": "english"},
                    "authorId": {"type": "keyword"},
                    "authorHandle": {"type": "keyword"},
                    "createdAt": {"type": "date", "format": "epoch_millis"},
                    "likeCount": {"type": "long"},
                    "retweetCount": {"type": "long"},
                    "quoteCount": {"type": "long"},
                    "replyCount": {"type": "long"},
                    "tweetId": {"type": "keyword"}
                }
            }
        }))
        .send()
        .await
        .wrap_err("create ES index")?;
    let status = resp.status_code().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        // "resource_already_exists_exception" = a previous run created it.
        let already = body
            .pointer("/error/type")
            .and_then(Value::as_str)
            .is_some_and(|t| t.contains("already_exists"));
        if !already {
            bail!("create ES index failed ({status}): {body}");
        }
    }
    Ok(())
}

/// Progress counters from a bulk push.
pub struct BuildStats {
    pub tweets: u64,
    pub authors: u64,
    pub malformed: u64,
}

/// Read ingress JSONL files (READ-ONLY) and bulk-push tweets into ES.
/// Author records build the id -> handle map; tweets referencing an unseen
/// author id get an empty handle (raw id shows at query time).
///
/// # Errors
///
/// Fails on unreadable files, failed bulk batches, or failed batch items.
pub async fn build_from_files(files: &[PathBuf], client: &Elasticsearch) -> Result<BuildStats> {
    ensure_index(client).await?;
    let mut author_map: HashMap<String, String> = HashMap::new();
    // (tweetId, source doc): indexed with _id = tweetId so a re-push is
    // idempotent (same id -> overwrite, not duplicate).
    let mut buffer: Vec<(String, Value)> = Vec::with_capacity(BULK_BATCH);
    let mut stats = BuildStats {
        tweets: 0,
        authors: 0,
        malformed: 0,
    };
    for file in files {
        let reader = BufReader::new(
            std::fs::File::open(file).wrap_err_with(|| format!("open {}", file.display()))?,
        );
        for line in reader.lines() {
            let line = line.wrap_err("read line")?;
            let trimmed = line.trim();
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
                    buffer.push((
                        tweet.id.as_str().to_string(),
                        json!({
                            "text": tweet.text,
                            "authorId": tweet.author_id.as_str(),
                            "authorHandle": handle,
                            "createdAt": tweet.created_at,
                            "likeCount": tweet.metrics.likes,
                            "retweetCount": tweet.metrics.retweets,
                            "quoteCount": tweet.metrics.quotes,
                            "replyCount": tweet.metrics.replies,
                            "tweetId": tweet.id.as_str(),
                        }),
                    ));
                    stats.tweets = stats.tweets.saturating_add(1);
                    if buffer.len() >= BULK_BATCH {
                        flush(client, &mut buffer).await?;
                    }
                }
                Err(err) => {
                    // Same failure policy as the pipeline: never crash the
                    // loop, never drop silently. Quarantine stays the
                    // pipeline's mechanism (this lane is READ-ONLY on data/);
                    // a stderr line + counter keeps the lane honest.
                    stats.malformed = stats.malformed.saturating_add(1);
                    eprintln!("malformed ingress line: {err}");
                }
            }
        }
    }
    flush(client, &mut buffer).await?;
    refresh(client).await?;
    Ok(stats)
}

/// One bulk request for the current buffer; retries/backoff live in the
/// Transport, and a failed batch or item is an error, never a silent drop.
async fn flush(client: &Elasticsearch, buffer: &mut Vec<(String, Value)>) -> Result<()> {
    if buffer.is_empty() {
        return Ok(());
    }
    let ops: Vec<BulkOperation<Value>> = buffer
        .iter()
        .map(|(id, doc)| BulkOperation::from(BulkIndexOperation::new(json!(doc)).id(id.as_str())))
        .collect();
    let resp = client
        .bulk(elasticsearch::BulkParts::Index(index_name()))
        .body(ops)
        .send()
        .await
        .wrap_err("ES bulk request")?;
    let status = resp.status_code().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        bail!("ES bulk failed ({status}): {body}");
    }
    if body
        .pointer("/errors")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        let first = body.pointer("/items/0").cloned().unwrap_or(Value::Null);
        bail!("ES bulk item error: {first}");
    }
    buffer.clear();
    Ok(())
}

async fn refresh(client: &Elasticsearch) -> Result<()> {
    let resp = client
        .indices()
        .refresh(elasticsearch::indices::IndicesRefreshParts::Index(&[
            index_name(),
        ]))
        .send()
        .await
        .wrap_err("ES refresh")?;
    if !resp.status_code().is_success() {
        bail!("ES refresh failed: {}", resp.status_code().as_u16());
    }
    Ok(())
}

/// Query parameters accepted by the HTTP lane.
#[derive(Debug, Default, Deserialize)]
pub struct SearchParams {
    /// Free-text query (english-analyzed BM25 over tweet text).
    pub q: Option<String>,
    /// Author handle OR author id filter (keyword exact match).
    pub author: Option<String>,
    /// Unix ms lower bound (inclusive).
    pub since: Option<u64>,
    /// Unix ms upper bound (inclusive).
    pub until: Option<u64>,
    /// Max hits (clamped to 200).
    pub limit: Option<usize>,
}

/// Execute `params` against ES, returning the stable proxy response.
///
/// # Errors
///
/// Fails on empty queries, `since > until`, or an ES error response.
pub async fn serve_query(client: &Elasticsearch, params: &SearchParams) -> Result<Value> {
    let limit = params.limit.unwrap_or(20).clamp(1, 200);
    let mut must: Vec<Value> = Vec::new();
    if let Some(q) = params.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        must.push(json!({"match": {"text": {"query": q, "operator": "and"}}}));
    }
    if let Some(author) = params
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        must.push(json!({"bool": {"should": [
            {"term": {"authorHandle": author}},
            {"term": {"authorId": author}},
        ], "minimum_should_match": 1}}));
    }
    match (params.since, params.until) {
        (Some(since), Some(until)) if since > until => bail!("since must be <= until"),
        (since, until) => {
            // Only the bounds the caller supplied: u64::MAX is not a valid
            // epoch_millis date, so an unbounded side must stay out of the
            // range clause entirely.
            let mut range = serde_json::Map::new();
            if let Some(since) = since {
                range.insert("gte".to_owned(), json!(since));
            }
            if let Some(until) = until {
                range.insert("lte".to_owned(), json!(until));
            }
            if !range.is_empty() {
                must.push(json!({"range": {"createdAt": range}}));
            }
        }
    }
    if must.is_empty() {
        bail!("empty query: provide q, author, or a time range");
    }
    let resp = client
        .search(elasticsearch::SearchParts::Index(&[index_name()]))
        .from(0)
        .size(i64::from(u32::try_from(limit).unwrap_or(u32::MAX)))
        .body(json!({
            "query": {"bool": {"must": must}},
            "_source": ["tweetId", "text", "authorHandle", "createdAt"],
            "track_total_hits": true,
        }))
        .send()
        .await
        .wrap_err("ES search")?;
    let status = resp.status_code().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        bail!("ES search failed ({status}): {body}");
    }
    let total = body
        .pointer("/hits/total/value")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let results = body
        .pointer("/hits/hits")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, Clone::clone)
        .into_iter()
        .map(|hit| {
            let src = hit.get("_source").cloned().unwrap_or(Value::Null);
            json!({
                "tweetId": src.get("tweetId").cloned().unwrap_or(Value::Null),
                "text": src.get("text").cloned().unwrap_or(Value::Null),
                "authorHandle": src.get("authorHandle").cloned().unwrap_or(Value::Null),
                "createdAt": src.get("createdAt").cloned().unwrap_or(Value::Null),
                "score": hit.get("_score").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "total": total,
        "count": results.len(),
        "results": results,
        "source": "second fast source of truth (self-hosted Elasticsearch/Lucene); Convex remains the primary source of truth",
    }))
}

/// Serve GET /search and GET /stats on 127.0.0.1 — one stable local interface
/// so the web lane never needs to know ES internals.
///
/// # Errors
///
/// Fails when the transport cannot be built, ES is unreachable, or the port
/// is taken.
pub async fn serve(port: u16, cfg: &EsConfig) -> Result<()> {
    use axum::extract::{Query, State};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::{Json, Router};
    use std::sync::Arc;

    let client = Arc::new(cfg.transport()?);
    let ping = client.ping().send().await.wrap_err("ES ping")?;
    if !ping.status_code().is_success() {
        bail!("ES ping failed: {}", ping.status_code().as_u16());
    }
    let app = Router::new()
        .route(
            "/search",
            get(
                |State(state): State<Arc<Elasticsearch>>,
                 Query(params): Query<SearchParams>| async move {
                    match serve_query(&state, &params).await {
                        Ok(value) => axum::response::IntoResponse::into_response(Json(value)),
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
            get(|State(state): State<Arc<Elasticsearch>>| async move {
                let docs = match state
                    .indices()
                    .stats(elasticsearch::indices::IndicesStatsParts::Index(&[
                        index_name(),
                    ]))
                    .send()
                    .await
                {
                    Ok(r) => {
                        let body: Value = r.json().await.unwrap_or(Value::Null);
                        body.pointer("/_all/primaries/docs/count")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                    }
                    Err(_) => 0,
                };
                Json(json!({
                    "docs": docs,
                    "index": index_name(),
                    "source": "second fast source of truth (self-hosted Elasticsearch/Lucene); Convex remains the primary source of truth",
                }))
            }),
        );
    let app = app.with_state(client);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .wrap_err_with(|| format!("bind {addr}"))?;
    eprintln!(
        "second fast source of truth (self-hosted Elasticsearch/Lucene) on http://{addr} — Convex remains the primary source of truth"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .wrap_err("serve")
}
