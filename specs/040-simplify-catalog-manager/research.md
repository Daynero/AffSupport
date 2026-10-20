# Research decisions

- Decision: retain 039 profile/version contracts and scheduler. Rationale: correction is UX and reliability; replacing persistence risks existing settings. Alternative: new schema rejected.
- Decision: one explicit Save for schedule and contents; remove immediate row picker. Rationale: predictable atomic intent. Alternative: keeping both repeats audit failure.
- Decision: separate detail surface and compact bulk toolbar. Rationale: keep list context and avoid nested row scroll. Alternative: expanding editor within short list rejected.
- Decision: load defaults only in space settings. Rationale: rare configuration must not delay list. Verify setter behavior before integration.
- Decision: retain current typed analytics seams and document missing producer evidence. No content, names, URLs, or search text collected.
- Decision: expert score never substitutes for user sessions; test measurable correctness and visually inspect beta without resetting data.
