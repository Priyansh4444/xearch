//! Branded domain identities — the Rust twin of
//! `apps/collector/src/contracts/ids.ts` and `convex/contracts/ids.ts`.
//!
//! A tweet id, author id, handle, or term must never silently swap places with
//! another. Each brand is a distinct type but serializes as a plain string
//! (`serde(transparent)`), so ingress JSONL, the Convex wire payloads, and the
//! golden fixtures are all byte-identical.
//!
//! Like the TypeScript brands, these assert the *space*, not the value: no
//! emptiness validation happens at decode (INGRESS.md: serde rejects malformed
//! shapes; the TS collector already guarantees non-empty ids upstream).

use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            /// Borrow the inner string for comparisons against raw lexicon words.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl std::borrow::Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }

        impl std::ops::Deref for $name {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }

        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                self.0 == **other
            }
        }

        impl PartialEq<$name> for &str {
            fn eq(&self, other: &$name) -> bool {
                **self == other.0
            }
        }
    };
}

string_id!(
    /// Source tweet id (`tweets.tweetId`, the ingest idempotency key).
    /// NOT a Convex doc id and NOT a `rawFile#index` locator.
    TweetId
);
string_id!(
    /// Source author id (`tweets/postings/authors.authorId`).
    AuthorId
);
string_id!(
    /// Normalized author handle (lowercase, no `@`).
    Handle
);
string_id!(
    /// Tokenizer-normalized index term (or `~aspect` token). The tokenizer is
    /// the sole producer; everything downstream only carries the brand.
    Term
);
