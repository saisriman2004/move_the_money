# 18. Architecture documentation

**What.**
- [architecture.md](../architecture.md): components with a diagram, the money path and the event path, key decisions with their trade-offs, and the data model.
- [financial-integrity.md](../financial-integrity.md): each money guarantee, how it's enforced twice (application and database), and the evidence.
- [failure-modes.md](../failure-modes.md): what happens when each part fails, with how it was verified, and the known gaps.
- [scaling.md](../scaling.md): what scales horizontally, where the limits appear first, and what to do about each.
- [api.md](../api.md): the endpoint reference and error codes, moved out of the README.

The README became an overview: what the platform guarantees, how to run and test it, and where to read more.

**How it was checked.** Every relative link in the README and `docs/` resolves. The architecture diagram (Mermaid) was rendered in Chrome with the Mermaid library to confirm it parses and shows the intended flows. Claims in the documents point at the tests, measurements or observations behind them, and anything not verified is labelled as such (for example, the CI end-to-end job not yet having run on GitHub).
