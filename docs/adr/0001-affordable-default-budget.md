# 0001: Default budget covers one full Sonnet 4.5 reply

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

OpenRouter reserves a request against the key and the account balance as if the
model produced its entire `max_completion_tokens`. A key with a smaller limit is
rejected before the first token, even when the actual reply would cost far less.

The previous default budget was 50 cents ($0.50), while the default model was
`openrouter/anthropic/claude-sonnet-4.5`. Sonnet 4.5 reports a 64,000-token
maximum completion and costs $15 per million completion tokens, so one
maximum-length reply reserves:

```text
64,000 tokens × $15 / 1,000,000 tokens = $0.96
```

Every fresh Grill-Me Session therefore failed its credit preflight before it
could start. The same pairing could also refuse an Agent attempt.

## Decision

Keep Sonnet 4.5 as the default model and raise the default per-Issue and
per-Session budget from 50 to **100 cents ($1.00)**.

- The same default applies to Issue keys, Agent attempt keys and session keys.
- There is no per-request reply cap. A reply may use the model's full limit.
- A free or cheaper model still works under the default budget.
- A deployment that configures a lower budget for a model with a larger
  reservation is refused at startup of the session or attempt, with the budget,
  the required amount and the setting to change.
- The existing $5.00 hard ceiling and per-Issue/per-Session overrides are
  unchanged.

## Consequences

A fresh Project with no model choice and no budget override can start a
Grill-Me Session, and its first ready Issue gets the same affordable cap.

The default spends at most $1.00 per Issue or Session. That is deliberately
close to one Sonnet 4.5 maximum reply; developers who expect several long turns
should raise the budget in Settings. If Sonnet's price or maximum reply grows,
the default pairing must be revisited, and the preflight will name the exact
shortfall rather than dispatching a Job OpenRouter would reject.
