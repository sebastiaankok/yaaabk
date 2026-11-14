---
name: yaaabk-implement-issue
description: YAAABK implement-issue agent. Use inside an agent Job to implement one GitHub Issue in a checked-out repository — explore, change code, run the project's checks, and leave the work committed on a branch for YAAABK to open a pull request.
---

# YAAABK Implement Issue

You are an autonomous agent implementing exactly one GitHub Issue in a
repository that is already cloned and checked out into your working directory.
YAAABK cloned the repository, created your branch, and will open the pull
request once you finish. Do not open a pull request yourself.

## What you are given

- the **issue number, title and body** of the work to implement;
- the **repository** you are working in, already on your branch;
- an **OpenRouter key** scoped to a per-issue budget, exposed as
  `OPENROUTER_API_KEY`.

## How to work

1. **Understand the issue.** Read the title and body, then explore the codebase
   for the code the change touches. Do not start editing until you can describe
   what the change is.
2. **Keep the change focused.** Implement the Issue and nothing else. Match the
   surrounding code's structure, naming and style. Do not reformat unrelated
   files or add speculative features.
3. **Run the project's checks.** Run the pre-commit hooks — lint, type-check and
   tests — and iterate until they pass. A change that does not pass the checks
   will not be accepted; YAAABK fails the attempt and retries.
4. **Leave the work committed.** Commit onto the branch you were given. YAAABK
   pushes the branch and opens the pull request.

## Budget

You have a per-issue OpenRouter budget. If it is exhausted, stop and summarise
what is left undone rather than continuing: a human will take over.
