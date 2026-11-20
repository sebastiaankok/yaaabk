---
name: YAAABK To Issues
description: Break a reported YAAABK Plan into vertical-slice Issues that each cut through the full stack. Quizzes the Developer on granularity and dependencies in guided mode, validates them itself in autonomous mode, labels every slice ready, and reports them through report_issues.
---

# YAAABK To Issues

Use this skill after `to-prd` has reported the Plan, in the same Grill-Me Session.

## Mode

Read the Project mode from the Plan conversation or the opening prompt. A
missing mode behaves as guided. The mode changes how the breakdown is checked,
not the Finish invariant: in both modes `report_issues` stores a draft.

- **Autonomous**: cut the slices, validate every `depends_on` title exists and
  the graph is acyclic, and report through `report_issues` without quizzing the
  Developer. Do not ask about granularity or dependencies; pick the recommended
  split and say so in the closing summary.
- **Guided**: show the breakdown grouped by wave and quiz the Developer as
  described below before reporting.

## 1. Start from the Plan

Read the Plan you just reported and the conversation around it. The Plan is the
source of truth: do not invent scope it does not contain, and do not shrink it.

## 2. Cut vertical slices

Before you write Issue titles, summaries, or bodies, load the `simple-english`
skill with the `skill` tool and apply its rules to all generated prose.

For every Issue, write a **summary**: one or two plain sentences in simple
English, with no Markdown and no line breaks, that say what the Issue delivers.
Keep it at most 200 characters. The summary is YAAABK-only UI data; it never
becomes part of the GitHub Issue body.

Each Issue must be a **vertical slice** that cuts through the whole stack the
change needs — schema or migration, API or module interface, UI or command, and
tests — so an Agent can implement and verify it on its own.

- **Independently implementable**: an Agent can grab the Issue, branch from the
  current default branch, and finish it without unmerged work from another
  Issue.
- **Independently grabbable**: the Issue body names the behaviour, the affected
  modules, the data change (or "none") and how to test it.
- **Not a horizontal layer**: "add the database schema" or "build the UI" are
  not slices. "Let a Developer save a bookmark end to end" is.
- **Small enough to review**, but not so small that it leaves the stack broken.
  When in doubt, prefer a working end-to-end slice over a clean layer.
- The first slice should produce something a Developer can exercise.

### Executable acceptance checks

Prefer an executable acceptance check: a concrete command or test to run and
the expected pass/fail result. A rendered behaviour is acceptable when an
automated UI test asserts it and the Issue names that command.

The Agent model is text-only and the Agent image has no browser. Never write an
acceptance check that asks an Agent to install a browser, Playwright, Chromium,
or to take screenshots. If a slice needs a Developer's eye, say what to look at
in the body and let the Developer check it after the pull request; still label
the Issue `ready`. See
`docs/adr/0003-generated-issues-are-always-ready.md`.

### Issue body template

Every Issue body uses this shape. Replace the examples with real commands and
real expected results for the slice:

```markdown
## What to build

The behaviour, the affected modules and the data change (or "none").

## Acceptance criteria

- [ ] `bun test` passes and reports the new tests.
```

An executable acceptance bullet starts with a command in backticks and says
what a passing or failing result looks like. A manual bullet may describe what
the Developer should look at after the pull request. A vague statement like
"the page looks right" is not an acceptance check.

Order the slices by what unblocks what. Express ordering only with
`depends_on`: the titles of the Issues that must be implemented first. The graph
must be acyclic.

## 3. Label every Issue ready

Every Issue you report gets `["ready"]`. `ready` means the Issue is grabbable
right away. Do not label an Issue `needs-human`, `blocked` or
`refinement-needed`; YAAABK applies `needs-human` only later, when an Agent
escalates a stuck Issue. Ordering belongs in `depends_on`.

## 4. Quiz the Developer in guided mode

In guided mode, before reporting, show the proposed breakdown grouped by wave
(the Issues with no dependencies first, then the ones they unblock) and quiz the
Developer:

- Ask **one question at a time** about granularity and dependencies, for example
  "The auth slice includes both the token store and the login screen — should
  that split?"
- When the Developer changes a slice, update its title, body, label and any
  `depends_on` references that named it. Reflect every piece of feedback before
  asking the next question.
- Re-check that every dependency title still exists and the graph is acyclic.
- Re-check every acceptance check with the Developer's changes in place.
- Stop when the Developer confirms the breakdown. If the Developer has no notes,
  say so and report it.

In autonomous mode, skip this quiz: validate every dependency title, the
acyclic graph and every acceptance check yourself, then report the breakdown
without waiting for feedback.

## 5. Validate acceptance checks

Run this validation before you call `report_issues`, in both modes. For every
Issue labelled `ready`:

- [ ] The body has an `## Acceptance criteria` section.
- [ ] At least one bullet names a runnable command and its expected result.
- [ ] Every manual bullet says what the Developer should look at after the pull
      request.
- [ ] The commands can run in the Agent image. Do not name a browser,
      Playwright, Chromium or a screenshot.

If a bullet fails, do not invent a command. Replace the check with a real
automated check that the slice adds, or state plainly what the Developer should
look at after the pull request. Keep the label `ready`. Run this validation
again after every edit, and do not call the tool until it passes.

## 6. Report the list

Call the `report_issues` tool from the `yaaabk` MCP server with one array. Each
entry has exactly these fields:

| Field | Type | Contents |
| --- | --- | --- |
| `title` | string | Short, unique, imperative title. |
| `summary` | string | One or two plain sentences, no Markdown, at most 200 characters. |
| `body` | string | What to build as Markdown, with an `## Acceptance criteria` section that names a runnable command and its expected result. |
| `labels` | string[] | `["ready"]`. |
| `depends_on` | string[] | Titles of Issues that must land first; `[]` when none. |

```json
{
  "issues": [
    {
      "title": "Save a bookmark end to end",
      "summary": "Let a Developer save a link and find it again.",
      "body": "## What to build\n\nAdd the bookmarks table and migration, a repository function, the save form and its tests.\n\n## Acceptance criteria\n\n- [ ] `bun test` passes and reports the new bookmark tests.",
      "labels": ["ready"],
      "depends_on": []
    },
    {
      "title": "Search saved bookmarks by title and tag",
      "summary": "Let a Developer search saved bookmarks by title and tag.",
      "body": "## What to build\n\nAdd the search query, API and list filter.\n\n## Acceptance criteria\n\n- [ ] `bun test` passes and reports the new search tests.",
      "labels": ["ready"],
      "depends_on": ["Save a bookmark end to end"]
    }
  ]
}
```

If the tool rejects the report, fix exactly what it names and call it again.
A successful call stores a **draft**.

If the call fails with a connection error ("Connection closed", a timeout or a
5xx), the terminal may have reconnected underneath you. Retry the same list
before concluding that anything was lost; a retry replaces the draft and is
safe.

## 7. Finish

Tell the Developer the Plan and Issues are ready as drafts. The Project changes
only when they click **Finish** in YAAABK, which publishes both together. A
cancelled session leaves nothing behind. This manual Finish step is the same in
guided and autonomous mode: an autonomous session still stops at drafts and
never publishes on its own. Do not ask the Developer to paste the Issues
anywhere, and do not create GitHub Issues yourself.
