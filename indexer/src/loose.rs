//! Direct tweet ingest: accept ingress JSONL *or* looser tweet-shaped JSON.
//!
//! The collector's `FxTwitter` mapping stays the source of truth for a full
//! archive. This path exists so a file of tweets can be indexed without that
//! pipeline — best-effort field mapping, then the same INGRESS gates.

use crate::ids::{AuthorId, Handle, TweetId};
use crate::model::{AuthorIn, IngressRecord, MediaIn, Metrics, TweetIn, VisualMediaType};
use serde::Deserialize;

pub enum ParsedLine {
    Ingress(IngressRecord),
    Tweet {
        tweet: TweetIn,
        author: Option<AuthorIn>,
    },
}

/// Parse one JSONL line. Ingress records win; anything else is treated as a
/// loose tweet (`FxTwitter` status, or a flat `{id, text, authorId, ...}` object).
///
/// # Errors
///
/// Returns a reason when the line is not JSON or lacks `id` and `text`.
pub fn parse_line(line: &str) -> Result<ParsedLine, String> {
    let probe: serde_json::Value =
        serde_json::from_str(line).map_err(|err| format!("parse: {err}"))?;
    if probe.get("kind").is_some() {
        let record: IngressRecord =
            serde_json::from_value(probe).map_err(|err| format!("parse: {err}"))?;
        return Ok(ParsedLine::Ingress(record));
    }
    let raw: LooseTweet =
        serde_json::from_value(probe).map_err(|err| format!("parse: {err}"))?;
    let tweet_id = raw
        .id
        .filter(|id| !id.is_empty())
        .ok_or("gate: missing id")?;
    let text = raw
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or("gate: empty text")?
        .to_string();
    if raw.r#type.as_deref() == Some("tombstone") {
        return Err("gate: tombstone".to_string());
    }
    let nested = raw.author.as_ref();
    let author_id = raw
        .author_id
        .clone()
        .or_else(|| nested.and_then(|author| author.id.clone()))
        .filter(|id| !id.is_empty())
        .ok_or("gate: missing authorId")?;
    let handle = raw
        .author_handle
        .clone()
        .or_else(|| nested.and_then(|author| author.screen_name.clone()))
        .unwrap_or_else(|| author_id.clone());
    let created_at = to_epoch_ms(
        raw.created_at
            .or(raw.created_timestamp)
            .ok_or("gate: missing createdAt")?,
    );
    let nested_metrics = raw.metrics.as_ref();
    let likes = first_count([raw.likes, nested_metrics.and_then(|m| m.likes)]);
    let retweets = first_count([
        raw.reposts,
        raw.retweets,
        nested_metrics.and_then(|m| m.retweets),
    ]);
    let quote_count = first_count([raw.quotes, nested_metrics.and_then(|m| m.quotes)]);
    let replies = first_count([raw.replies, nested_metrics.and_then(|m| m.replies)]);
    let metrics_at = raw.metrics_at.map_or(created_at, to_epoch_ms);
    let media = flatten_media(raw.media.as_ref());
    let quoted_id = raw
        .quoted_tweet_id
        .or_else(|| nested_id(raw.quote.as_ref()));
    let retweet_of = raw
        .retweet_of_tweet_id
        .or_else(|| nested_id(raw.reposted_status.as_ref()));
    let reply_to = raw
        .in_reply_to_tweet_id
        .or_else(|| raw.replying_to.as_ref().and_then(|r| r.status.clone()));
    let author = nested.map(|a| AuthorIn {
        id: AuthorId(author_id.clone()),
        handle: Handle(handle.clone()),
        display_name: a.name.clone().unwrap_or_else(|| handle.clone()),
        follower_count: a.followers.unwrap_or(0),
        following_count: a.following.unwrap_or(0),
        verified: a
            .verification
            .as_ref()
            .and_then(|v| v.verified)
            .unwrap_or(false),
        created_at: a.joined_ms.unwrap_or(created_at),
        bio: a.description.clone(),
        avatar_url: a.avatar_url.clone(),
    });
    Ok(ParsedLine::Tweet {
        tweet: TweetIn {
            id: TweetId(tweet_id),
            text,
            author_id: AuthorId(author_id),
            created_at,
            metrics: Metrics {
                likes,
                retweets,
                quotes: quote_count,
                replies,
            },
            metrics_at,
            media,
            quoted_tweet_id: quoted_id.map(TweetId),
            retweet_of_tweet_id: retweet_of.map(TweetId),
            in_reply_to_tweet_id: reply_to.map(TweetId),
            lang: raw.lang,
            entities: None,
        },
        author,
    })
}

impl ParsedLine {
    #[must_use]
    pub fn into_records(self) -> Vec<IngressRecord> {
        match self {
            Self::Ingress(record) => vec![record],
            Self::Tweet { tweet, author } => {
                let mut records = Vec::new();
                if let Some(author) = author {
                    records.push(IngressRecord::Author(author));
                }
                records.push(IngressRecord::Tweet(tweet));
                records
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct LooseTweet {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default, alias = "authorId")]
    author_id: Option<String>,
    #[serde(default, alias = "authorHandle")]
    author_handle: Option<String>,
    #[serde(default, alias = "createdAt")]
    created_at: Option<i64>,
    #[serde(default)]
    created_timestamp: Option<i64>,
    #[serde(default, alias = "metricsAt")]
    metrics_at: Option<i64>,
    #[serde(default)]
    likes: Option<u64>,
    #[serde(default)]
    reposts: Option<u64>,
    #[serde(default)]
    retweets: Option<u64>,
    #[serde(default)]
    quotes: Option<u64>,
    #[serde(default)]
    replies: Option<u64>,
    #[serde(default)]
    metrics: Option<LooseMetrics>,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default)]
    author: Option<LooseAuthor>,
    #[serde(default)]
    media: Option<LooseMedia>,
    #[serde(default, alias = "quotedTweetId")]
    quoted_tweet_id: Option<String>,
    #[serde(default, alias = "retweetOfTweetId")]
    retweet_of_tweet_id: Option<String>,
    #[serde(default, alias = "inReplyToTweetId")]
    in_reply_to_tweet_id: Option<String>,
    #[serde(default)]
    quote: Option<LooseRef>,
    #[serde(default)]
    reposted_status: Option<LooseRef>,
    #[serde(default)]
    replying_to: Option<LooseReply>,
}

#[derive(Debug, Deserialize)]
struct LooseMetrics {
    #[serde(default)]
    likes: Option<u64>,
    #[serde(default)]
    retweets: Option<u64>,
    #[serde(default)]
    quotes: Option<u64>,
    #[serde(default)]
    replies: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct LooseAuthor {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    screen_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    followers: Option<u64>,
    #[serde(default)]
    following: Option<u64>,
    #[serde(default)]
    verification: Option<LooseVerification>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    joined_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct LooseVerification {
    #[serde(default)]
    verified: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct LooseMedia {
    #[serde(default)]
    all: Option<Vec<LooseMediaItem>>,
}

#[derive(Debug, Deserialize)]
struct LooseMediaItem {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LooseRef {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LooseReply {
    #[serde(default)]
    status: Option<String>,
}

fn first_count(values: impl IntoIterator<Item = Option<u64>>) -> u64 {
    values.into_iter().flatten().next().unwrap_or(0)
}

const fn to_epoch_ms(value: i64) -> i64 {
    // FxTwitter `created_timestamp` is seconds; ingress `createdAt` is ms.
    if value > 0 && value < 1_000_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn nested_id(value: Option<&LooseRef>) -> Option<String> {
    value
        .and_then(|item| item.id.clone())
        .filter(|id| !id.is_empty())
}

fn flatten_media(media: Option<&LooseMedia>) -> Vec<MediaIn> {
    let Some(media) = media else {
        return Vec::new();
    };
    let Some(items) = media.all.as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(url) = item.url.as_deref().filter(|url| !url.is_empty()) else {
            continue;
        };
        let Some(kind) = item.r#type.as_deref().and_then(parse_media_type) else {
            continue;
        };
        out.push(MediaIn {
            r#type: kind,
            url: url.to_string(),
        });
    }
    out
}

fn parse_media_type(raw: &str) -> Option<VisualMediaType> {
    match raw.to_ascii_lowercase().as_str() {
        "image" | "photo" => Some(VisualMediaType::Image),
        "video" => Some(VisualMediaType::Video),
        "gif" | "animated_gif" => Some(VisualMediaType::Gif),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_field_does_not_fall_through_to_loose() {
        let line = r#"{"kind":"tweet","id":"t1","text":"hello"}"#;
        assert!(parse_line(line).is_err());
    }

    #[test]
    fn ingress_line_still_wins() {
        let line = r#"{"kind":"tweet","id":"t1","text":"hello","authorId":"a1","createdAt":1700000000000,"metrics":{"likes":0,"retweets":0,"quotes":0,"replies":0},"metricsAt":1700000000000,"media":[],"quotedTweetId":null,"retweetOfTweetId":null,"inReplyToTweetId":null}"#;
        let ParsedLine::Ingress(IngressRecord::Tweet(tweet)) = parse_line(line).unwrap() else {
            panic!("expected ingress tweet");
        };
        assert_eq!(tweet.id, "t1");
    }

    #[test]
    fn fxtwitter_status_becomes_a_tweet_and_author() {
        let line = r#"{"type":"status","id":"1001","text":"plain post","created_timestamp":1700090000,"likes":5,"reposts":1,"quotes":0,"replies":2,"lang":"en","author":{"id":"100","screen_name":"Seed","name":"Seed Account","followers":10,"following":3,"verification":{"verified":true}},"media":{"all":[{"type":"photo","url":"https://pbs.example.com/x.jpg"}]}}"#;
        let ParsedLine::Tweet { tweet, author } = parse_line(line).unwrap() else {
            panic!("expected loose tweet");
        };
        assert_eq!(tweet.id, "1001");
        assert_eq!(tweet.created_at, 1_700_090_000_000);
        assert_eq!(tweet.metrics.likes, 5);
        assert_eq!(tweet.media.len(), 1);
        let author = author.expect("nested author");
        assert_eq!(author.handle, "Seed");
        assert!(author.verified);
    }
}
