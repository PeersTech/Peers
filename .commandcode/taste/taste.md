# Taste

## Workflow
- Prefers autonomous execution on multi-phase projects: keep working through the plan without pausing for confirmation between steps; an explicit "continue" after hitting an obstacle confirms pushing through environment/tooling issues independently. Confidence: 0.9
- Wants a git commit pushed at the completion of each phase/milestone of a long-running effort. Confidence: 0.9
- Tracks multi-phase work in a committed markdown plan file (e.g., TS-MIGRATION.md) used as the source of truth for progress; update the plan doc as part of completing each phase. Confidence: 0.7
t original being ported) to extract conventions before designing, then mirrors those patterns exactly — same signing scheme (canonical JSON + Ed25519), topic/naming conventions, and module structure — rather than inventing new designs. Confidence: 0.8
- Gates phase completion on tsc, eslint, and the full test suite all passing. Confidence: 0.8
- For security-sensitive code (signed payloads, handshakes), pairs happy-path round-trip tests with forgery, tampering, replay, and identity-swap rejection tests. Confidence: 0.7
