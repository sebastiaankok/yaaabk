---
name: YAAABK To PRD
description: Turn a settled YAAABK grill-me conversation into the Project's PRD. Explores the repository, checks the module sketch with the Developer, writes the PRD template and reports it through report_prd, then hands off to to-issues.
---

# YAAABK To PRD

Use this skill when the `grill-me` skill hands off a settled plan, or when the
Developer says **"write the PRD now"**. The PRD is the durable document a later
session, a reviewer or an Agent reads instead of the conversation.

## 1. Gather what the conversation settled

Read the conversation you just had and the Project's active Plan, when there is
one. Explore the repository when a fact matters; do not re-ask decisions the
Developer already made.

- The problem and who has it.
- The chosen approach and the alternatives that were rejected, with the reason.
- The boundaries: what the PRD deliberately does not cover.
- The data and interfaces the work touches.
- The decisions that are still open. If one blocks the module sketch, ask exactly
  one question, then continue.

## 2. Sketch the modules

Before writing the PRD, sketch the technical shape in a few lines:

- **Refactored** modules whose responsibilities change.
- **New** modules and their narrow public interfaces.
- **Extended** modules that gain capability.
- **Unchanged** modules the work relies on.

Show the sketch to the Developer and ask one question: "Do these modules and
boundaries match how you want this built?" Reflect their corrections. Do not
write the PRD until the Developer has confirmed the sketch.

## 3. Write the PRD from the template

Write Markdown with exactly these sections, in this order:

```markdown
## Problem Statement

What hurts today, for whom, and why the current behaviour is not good enough.

## Solution

The chosen approach in plain language, including what it replaces.

## User Stories

1. As a **Developer**, I want ..., so that ...
2. ...

## Implementation Decisions

### Modules

**Refactored**

- ...

**New**

- ...

**Extended**

- ...

**Unchanged**

- ...

### API contracts

The routes, tools or interfaces the work adds or changes, with their inputs,
outputs and failure modes.

### Data

Any schema or storage change, or "none".

## Testing Decisions

What behaviour is tested through which public interface, and what is deliberately
not automated.

## Out of Scope

What this PRD does not cover, so later sessions do not assume it was agreed.

## Further Notes

Open questions, risks and context that does not fit above.
```

Rules:

- Write decisions and behaviour, not a file-by-file implementation plan.
- Every user story names the Developer's benefit. Do not invent requirements the
  conversation did not settle; put genuine open points under Further Notes.
- Keep it readable in one sitting. Prefer concrete nouns and verbs over jargon.
- Do not include a "Status", "Version" or "Author" section; YAAABK versions
  Plans itself.

## 4. Report the PRD

Call the `report_prd` tool from the `yaaabk` MCP server with the PRD markdown:

```json
{ "prd": "## Problem Statement\n\n..." }
```

If the tool rejects the report, fix exactly what it names and call it again.
A successful call stores a **draft**. Nothing is published until the Developer
clicks **Finish** in YAAABK.

## 5. Hand off to Issues

After `report_prd` succeeds, load the `to-issues` skill with the `skill` tool and
follow it. It turns this PRD into vertical slices and reports them through
`report_issues`. Do not repeat the module confirmation there and do not write
the Issue list yourself.
