---
name: YAAABK To Issues
description: Break a reported YAAABK PRD into vertical-slice Issues that each cut through the full stack. Quizzes the Developer on granularity and dependencies, maps AFK slices to ready and HITL slices to needs-human, and reports them through report_issues.
---

# YAAABK To Issues

Use this skill after `to-prd` has reported the PRD, in the same Grill-Me Session.

## 1. Start from the PRD

Read the PRD you just reported and the conversation around it. The PRD is the
source of truth: do not invent scope it does not contain, and do not shrink it.

## 2. Cut vertical slices

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

Order the slices by what unblocks what. Express ordering only with
`depends_on`: the titles of the Issues that must be implemented first. The graph
must be acyclic.

## 3. Label AFK and HITL work

Every Issue gets one of two intent labels:

| Label | Meaning |
| --- | --- |
| `ready` | AFK work: an Agent can implement and verify it without the Developer. |
| `needs-human` | HITL work: a decision, credential, external account or manual check only the Developer can do. |

Split HITL work out of an otherwise AFK slice instead of mixing both in one
Issue. Do not label an Issue `blocked` or `refinement-needed`; ordering belongs
in `depends_on`.

## 4. Quiz the Developer

Before reporting, show the proposed breakdown grouped by wave (the Issues with no
dependencies first, then the ones they unblock) and quiz the Developer:

- Ask **one question at a time** about granularity and dependencies, for example
  "The auth slice includes both the token store and the login screen — should
  that split?"
- When the Developer changes a slice, update its title, body, label and any
  `depends_on` references that named it. Reflect every piece of feedback before
  asking the next question.
- Re-check that every dependency title still exists and the graph is acyclic.
- Stop when the Developer confirms the breakdown. If the Developer has no notes,
  say so and report it.

## 5. Report the list

Call the `report_issues` tool from the `yaaabk` MCP server with one array. Each
entry has exactly these fields:

| Field | Type | Contents |
| --- | --- | --- |
| `title` | string | Short, unique, imperative title. |
| `body` | string | What to build as Markdown: behaviour, modules, data, testing. |
| `labels` | string[] | `["ready"]` or `["needs-human"]`. |
| `depends_on` | string[] | Titles of Issues that must land first; `[]` when none. |

```json
{
  "issues": [
    {
      "title": "Save a bookmark end to end",
      "body": "Add the bookmarks table and migration, a repository function, the save form and its tests.",
      "labels": ["ready"],
      "depends_on": []
    },
    {
      "title": "Search saved bookmarks by title and tag",
      "body": "Add the search query, API and list filter. Depends on saving bookmarks.",
      "labels": ["ready"],
      "depends_on": ["Save a bookmark end to end"]
    }
  ]
}
```

If the tool rejects the report, fix exactly what it names and call it again.
A successful call stores a **draft**.

## 6. Finish

Tell the Developer the PRD and Issues are ready as drafts. The Project changes
only when they click **Finish** in YAAABK, which publishes both together. A
cancelled session leaves nothing behind. Do not ask the Developer to paste the
Issues anywhere, and do not create GitHub Issues yourself.
