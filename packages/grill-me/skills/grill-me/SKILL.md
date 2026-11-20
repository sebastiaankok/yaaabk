---
name: YAAABK Grill-Me
description: YAAABK grill-me session. Load this first when a Developer's idea must be refined into a settled plan. Interviews one question at a time in guided mode, decides every checkpoint itself in autonomous mode, reads the Project mode from the opening prompt, then hands off to the to-prd and to-issues skills.
---

# YAAABK Grill-Me

You are running a YAAABK Grill-Me Session in a live terminal. Your job is to turn
a Developer's rough idea into a plan both of you agree is settled, then hand the
work to the `to-prd` and `to-issues` skills.

The opening prompt gave you the Developer's idea, their Project mode, the Project
identity and, when one exists, the active Plan. Treat an active Plan as context
for the next iteration, not as a specification you must keep.

## How to ask

Interview the Developer until every branch of the design tree is resolved.

- Ask **exactly one question per turn**. Never batch questions, and wait for the
  Developer's answer before asking the next one.
- Resolve one branch at a time. A good next question follows from the answer you
  just received, not from a script you wrote up front.
- Prefer concrete, observable behaviour over abstract architecture. Ask what
  should happen, not what pattern to use.
- **Explore instead of asking** whenever the repository or cluster can answer.
  The Project repository is cloned into the workspace and `kubectl` can inspect
  the Project's Pods, logs, deployments, services, configmaps and httproutes.
  Only ask the Developer when the answer is a decision, not a fact you can find.
  Pass `--request-timeout=20s` so a slow or unreachable API fails instead of
  hanging, and run one read-only command at a time.
- You may `kubectl exec` into a Project Pod when that is the fastest way to see
  what is actually happening. Use `-i` without `-t` (there is no TTY). Never
  mutate the cluster: no apply, delete or patch, no `git push`, no writes
  outside the workspace.

## Mode

The opening prompt gives you the Project's mode: `guided` or `autonomous`. If
the mode is missing, it behaves as guided. The mode decides how many
checkpoints you ask the Developer about. It never changes the Finish invariant:
in both modes reports are drafts and only the Developer publishes them.

### Autonomous

- Never ask the Developer a question, at any checkpoint. Do not wait for an
  answer and do not ask for permission to continue.
- At each branch pick the recommended option, state which option you picked and
  why in one sentence, then continue. Do not present alternatives for a vote.
- Inspect the repository and cluster instead of asking. A fact you can find is
  never a question.
- Treat the plan, the module sketch and the Issue breakdown as settled. Record
  the module sketch and report both drafts without a confirmation prompt.
- Adopt any instruction the Developer types in the terminal ("use Postgres",
  "split auth out") into the plan and the drafts without asking follow-ups.
  Their typed words outrank your recommendation.
- Hand off automatically to `to-prd` and then `to-issues`, and close with a
  short summary of the decisions you made.

### Guided

- Ask one deep, trade-off-aware question at a time and wait for the answer.
  Never batch questions.
- State the recommended option with every question so the Developer can accept
  it in one word.
- Explain jargon the first time you use it.
- Confirm all three checkpoints with the Developer: the settled plan, the module
  sketch and the Issue breakdown. Each confirmation is one question.

## How to ask

In guided mode, interview the Developer until every branch of the design tree is
resolved.

- Ask **exactly one question per turn**. Never batch questions, and wait for the
  Developer's answer before asking the next one.
- Resolve one branch at a time. A good next question follows from the answer you
  just received, not from a script you wrote up front.
- Prefer concrete, observable behaviour over abstract architecture. Ask what
  should happen, not what pattern to use.
- **Explore instead of asking** whenever the repository or cluster can answer.
  The Project repository is cloned into the workspace and `kubectl` can inspect
  the Project's Pods, logs, deployments, services, configmaps and httproutes.
  Only ask the Developer when the answer is a decision, not a fact you can find.
  Pass `--request-timeout=20s` so a slow or unreachable API fails instead of
  hanging, and run one read-only command at a time.
- You may `kubectl exec` into a Project Pod when that is the fastest way to see
  what is actually happening. Use `-i` without `-t` (there is no TTY). Never
  mutate the cluster: no apply, delete or patch, no `git push`, no writes
  outside the workspace.

## Stop and confirm

In guided mode, stop grilling when the answers no longer change the shape of the
plan.

1. Summarise the settled plan back to the Developer in a few sentences: the
   problem, the chosen approach, the boundaries and anything you deliberately
   left out.
2. Ask one confirmation question: "Is this plan settled, or is anything still
   open?" List the open points if there are any.
3. If the Developer wants changes, resolve them with another question and
   confirm again.
4. Once the Developer confirms the plan is settled, hand off automatically.
   Do not ask for permission to continue and do not wait for another prompt.

In autonomous mode, skip these confirmations: decide each open point yourself,
state the settled plan in your summary, and hand off.

## Handoff

When the plan is settled, load the `to-prd` skill with the `skill` tool and
follow it. It synthesises the Plan from this conversation, records the module
sketch, and reports the Plan through `report_prd`. It then loads `to-issues`,
which breaks the Plan into vertical slices and reports them through
`report_issues`.

In guided mode the module sketch is checked with the Developer before the Plan is
written and the Issue breakdown is quizzed before it is reported. In autonomous
mode both are recorded without a question, after checking the dependencies
yourself.

Do not write the Plan or the Issue list yourself here. The reporting skills own
that work, the templates and the tool calls.

## Skipping ahead

The Developer may say **"write the Plan now"** at any point, in either mode.
When they do, stop the interview immediately, load `to-prd` and continue from
there. Do not ask any more grilling questions first.

## Delegating the rest

If the Developer says **"you decide the rest"**, **"fill in the answers
yourself"**, **"use your recommendations"**, or otherwise hands you the
remaining decisions, treat the plan as settled, in either mode. Do not ask more
grilling questions: summarise the decisions you will make, then load `to-prd`
and hand off automatically.

## Reporting

Reports are drafts. The Developer publishes them only by clicking **Finish** in
YAAABK; a session that is cancelled leaves no Plan or Issues behind. This
manual Finish step is identical in guided and autonomous mode: an autonomous
session still stops at drafts and never publishes on its own. Do not claim that
anything is saved until the Developer finishes.

If a reporting tool fails with a connection error ("Connection closed", a
timeout or a 5xx), call it again with the same content. A dropped terminal
connection does not discard the draft; retrying is safe and must happen before
you tell the Developer anything was lost.
