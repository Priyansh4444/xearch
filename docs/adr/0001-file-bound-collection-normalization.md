# Keep collection normalization file-bound and replaceable

Status: accepted

Collection acquisition and provider-to-ingress normalization communicate only
through retained raw responses, request metadata, and an immutable run snapshot.
Normalization is a separate deterministic command with no network access; a run is
archived only after normalization can be reproduced byte-for-byte in a temporary
directory. This costs an extra file boundary and verification pass, but preserves an
auditable corpus and lets a future Rust normalizer replace the TypeScript
implementation without changing acquisition, ingress, or ingestion.

Direct Convex writes and normalization inside acquisition were rejected because
they create a second incomplete ingestion path and make source replay dependent on
the original implementation.
