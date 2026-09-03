# Xearch

Xearch builds a searchable corpus of public posts. This glossary distinguishes the
stages that move a post from its source into search results.

## Language

**Collection**:
Acquiring source data and deterministically normalizing it into the ingress contract.
_Avoid_: Retrieval, scraping

**Normalization**:
Deterministically mapping retained source data into complete ingress records,
rejections, and duplicate observations.
_Avoid_: Ingestion, shaping

**Corpus shaping**:
Selecting a serving corpus from normalized ingress records according to corpus
composition policy.
_Avoid_: Normalization, collection

**Seed account**:
A manually selected account whose timeline forms the initial corpus and supplies
interaction evidence for account discovery.
_Avoid_: Core account

**Discovered account**:
A non-seed account admitted for collection because enough distinct seed accounts
interacted with it.
_Avoid_: Random account, graph account

**Coverage floor**:
The reported authored-post count used to judge whether collection reached useful
depth for an account; it never stops collection.
_Avoid_: Quota, corpus size

**Timeline candidate**:
A potential post record returned as a top-level item on a collected timeline.
_Avoid_: Tweet

**Embedded candidate**:
A potential post record nested inside another source item, such as a quoted post.
_Avoid_: Timeline candidate

**Ingestion**:
Loading normalized ingress records into Convex serving state through the indexer.
_Avoid_: Collection, retrieval

**Retrieval**:
Finding query-time candidates from indexed serving state.
_Avoid_: Collection, ingestion
