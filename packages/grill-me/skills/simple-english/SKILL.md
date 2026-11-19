---
name: simple-english
description: Write YAAABK Plans and Issues in plain, simple English. Load this before writing any generated prose. It sets short sentences, active voice, simple tenses, one word for one meaning, condition before command, defined technical terms, and no AI slop.
---

# YAAABK Simple English

Use this skill before you write a Plan or an Issue title, summary, or body. Apply
these rules to all generated prose.

## Core rules

1. Write short sentences. Use one idea per sentence. Split a sentence when it
   grows past 20 words.
2. Use the active voice. Name the actor. Write "The backend stores the Plan",
   not "The Plan is stored by the backend".
3. Use simple tenses. Prefer the present or past tense, and do not use the
   present perfect. Write "The Agent opened a pull request", not "The Agent has
   opened a pull request".
4. Use one word for one meaning. Pick one term for a concept and keep it for the
   whole document. Do not switch between synonyms for variety.
5. Put the condition before the command. Write "If the build fails, read the
   log", not "Read the log if the build fails".
6. Define every technical term at its first use. Keep the definition to one
   short sentence. Do not define product names, standards, or the tools the
   document is about.
7. Remove AI slop. Delete words that carry no fact, such as "simply",
   "seamlessly", "robust", "powerful", "leverage", and "it is worth noting".
   State the fact, not its importance. Do not use decorative triplets or "not
   just X, it is Y".

## Leave these unchanged

Do not change code, identifiers, commands, flags, file paths, product names, or
quoted errors. Keep them exactly as written, even when they break a rule above.
Do not add a definition to a product name.

## Check before you report

Read each sentence and ask:

- Does it carry one idea and less than 20 words?
- Does it use the active voice and a simple tense?
- Does each term keep the same meaning?
- Does the condition come before the command?
- Is every technical term defined at its first use?
- Can you delete a word without losing a fact?
