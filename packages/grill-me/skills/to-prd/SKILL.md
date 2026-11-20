---
name: YAAABK To PRD
description: Turn a settled YAAABK grill-me conversation into the Project's Plan. Explores the repository, records the module sketch (confirming it only in guided mode), writes the Plan template and reports it through report_prd, then hands off to to-issues.
---

# YAAABK To PRD

Use this skill when the `grill-me` skill hands off a settled plan, or when the
Developer says **"write the Plan now"**. The Plan is the durable document a later
session, a reviewer or an Agent reads instead of the conversation.

## 1. Gather what the conversation settled

Read the conversation you just had and the Project's active Plan, when there is
one. Explore the repository when a fact matters; do not re-ask decisions the
Developer already made.

- The problem and who has it.
- The chosen approach and the alternatives that were rejected, with the reason.
- The boundaries: what the Plan deliberately does not cover.
- The data and interfaces the work touches.
- The decisions that are still open. If one blocks the module sketch, in guided
  mode ask exactly one question, then continue. In autonomous mode pick the
  recommended answer yourself and note the choice under Further Notes.

## 2. Sketch the modules

Before writing the Plan, sketch the technical shape in a few lines:

- **Refactored** modules whose responsibilities change.
- **New** modules and their narrow public interfaces.
- **Extended** modules that gain capability.
- **Unchanged** modules the work relies on.

Read the Project mode from the conversation or the opening prompt. A missing
mode behaves as guided.

In **guided** mode, show the sketch to the Developer and ask one question: "Do
these modules and boundaries match how you want this built?" Reflect their
corrections. Do not write the Plan until the Developer has confirmed the
sketch. If the Developer already delegated the remaining decisions ("you decide
the rest", "fill in the answers yourself", "use your recommendations"), pick
the sketch you recommend and continue without waiting for another confirmation.

In **autonomous** mode, pick the sketch you recommend, record it under
Implementation Decisions, and continue to write the Plan. Do not ask the
confirmation question and do not wait for the Developer. If the Developer typed
an instruction about the modules, adopt it as the sketch.

## 3. Write the Plan from the template

Before you write the Plan, load the `simple-english` skill with the `skill` tool
and apply its rules to every sentence. Write Markdown with exactly these
sections, in this order:

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

What this Plan does not cover, so later sessions do not assume it was agreed.

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
- Write a **summary** of the Plan as one or two plain sentences in simple
  English, with no Markdown and no line breaks. YAAABK shows it in lists and
  disclosures instead of the full document. Keep it at most 200 characters.

## 4. Report the Plan

Call the `report_prd` tool from the `yaaabk` MCP server with the Plan markdown
and its summary:

```json
{
  "prd": "## Problem Statement\n\n...",
  "summary": "Let Developers save bookmarks and find them again."
}
```

Every `report_prd` call needs both fields. If the tool rejects the report, fix
exactly what it names and call it again. A successful call stores a **draft**.
Nothing is published until the Developer clicks **Finish** in YAAABK. This
manual Finish step is the same in guided and autonomous mode: an autonomous
session still stops at drafts and never publishes on its own.

If the call fails with a connection error ("Connection closed", a timeout or a
5xx), the terminal may have reconnected underneath you. Retry the same report
before concluding that anything was lost; a retry overwrites the draft and is
safe.

## 5. Hand off to Issues

After `report_prd` succeeds, load the `to-issues` skill with the `skill` tool and
follow it. It turns this Plan into vertical slices and reports them through
`report_issues`. Do not repeat the guided module confirmation there and do not
write the Issue list yourself.
