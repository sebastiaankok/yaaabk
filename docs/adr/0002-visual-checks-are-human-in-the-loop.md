# 0002: Visual acceptance checks are human-in-the-loop

- **Status:** Superseded by [0003](0003-generated-issues-are-always-ready.md)
- **Date:** 2026-11-20

## Context

The `todo-app` Plan generated `ready` Issues with acceptance checks that ask the
Agent to look at the rendered page:

- "Read the page at 1280px and 375px wide. Confirm that the card centres and the
  header reads clearly."
- "Tab through the page and confirm that every control shows a focus ring. Force
  an API failure and confirm that the alert appears."
- "Open the page in light mode and in dark mode. Confirm that the page title
  shows in the tab."

A `ready` Issue promises AFK work: an Agent can implement and verify it without
the Developer. Those checks break that promise for two reasons:

- The Agent model used for that run was `baidu/ernie-5.5-flash-preview:free`, a
  text-only model. It cannot see a screenshot even when it takes one.
- The Agent image has no browser. It is the shared Alpine OpenCode runtime with
  git, GitHub CLI and kubectl, not a Playwright or Chromium image.

In the observed run the Agent tried to close the gap itself. It installed
Playwright, downloaded a glibc Chromium onto Alpine, built a sysroot, captured
screenshots it could not see, and reported "I can't view images with this
model." That burned turns and tokens without producing a verdict.

## Decision

Choose **option A: visual checks are human-in-the-loop.**

- Every `ready` Issue names an executable acceptance check: a concrete command
  or test and the expected pass/fail result.
- A check that needs a person to look at the page, judge appearance, or compare
  a screenshot is `needs-human`, not `ready`.
- A `ready` Issue may still assert rendered behaviour in code, such as a DOM
  query or an existing automated UI test, because its result is executable. It
  must name that command and expected result.
- The Agent must not install a browser, Chromium, Playwright or a glibc sysroot
  to satisfy an acceptance check. If no executable check exists, the Issue is
  `needs-human`.

This matches the current text-only model and the no-browser Agent image. It
keeps the image small and avoids adding a browser toolchain that the model
cannot use for visual judgement anyway.

## Consequences

- The `to-issues` skill must reject or relabel visual-only checks. Its
  validation step and fixture are tracked in Issue #166.
- Visual work is picked up by the Developer through the `needs-human` queue
  instead of an Agent attempt that cannot finish.
- Option B, adding Playwright and Chromium to the image and template for
  automated geometry, contrast and focus assertions, is not chosen now. It can
  be revisited if reproducible code-level UI checks become worth the larger
  image.
- Existing `ready` Issues with visual-only instructions need relabelling when
  they are picked up; no migration is required in this decision.
