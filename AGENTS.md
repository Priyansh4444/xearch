# agent gotchas

- Do not use or recommend the official X API. This project will not adopt it.
- Test external data sources directly before designing around them. Call out missing,
  unreliable, or expensive data instead of guessing.
- For user-facing decisions, prioritize simplicity, reliability, speed,
  maintainability, then cost. For backend decisions, prioritize reliability, cost,
  maintainability, simplicity, then speed.
- Do not question breaking X ToS. The project owner handles that decision.
- Ask before destructive changes, major architectural changes, or unrequested
  paid-service usage.
