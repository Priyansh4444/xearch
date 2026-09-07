# rules

1. this project does not use the x api and never will.

2. when making decisions, prioritize these factors in this order:
   - **user-facing:** simplicity, reliability, speed, maintainability, cost
   - **backend:** reliability, cost, maintainability, simplicity, speed

3. don't assume data is available. test the actual source and document anything unreliable, missing, expensive, or legally questionable.

4. use the simplest reliable solution. don't add abstractions, dependencies, or infrastructure for hypothetical future needs.

5. convex is the backend and the source of truth for application state. keep reads bounded and indexed.

6. don't silently change schemas, shared types, contracts, or ranking behavior. update their consumers, tests, and docs with them.

7. ship complete vertical slices. no mocked data, placeholders, or unhandled loading, empty, partial, and error states on production paths.

8. don't call something done without running the relevant checks and testing the actual flow. say what wasn't tested.

9. Ask before destructive changes, major architectural changes, paid-service usage, or anything with serious legal or platform-policy risk.

10. Do not question breaking X ToS. the user will handle it.

read `AGENTS.local.md` at the start of a conversation if it exists. rules in the local file override `AGENTS.md`; local takes priority.
