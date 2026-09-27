# learn-with-claude-code

A one-on-one AI tutor that refuses to let you memorise things, built to be read in Obsidian.

The teaching system is [amosblomqvist/learn](https://github.com/amosblomqvist/learn) by
[Eero Alvar](https://github.com/amosblomqvist) ([video](https://youtu.be/kzcI5F4tGiU)), written for
[pi](https://github.com/pi-labs-ai/pi). [metetik/learn-with-claude-code](https://github.com/metetik/learn-with-claude-code)
ported it to Claude Code's skills, subagents and hooks. This fork of that port changes two things:

- **You read every question in Obsidian before you answer it.** The terminal can't render LaTeX, so
  the lesson and the open question are written to your vault while the terminal waits for you,
  not after you reply. See [Reading in Obsidian](#reading-in-obsidian).
- **The tutor writes plainly.** Its messages follow rules adapted from Peter Yang's
  [no-ai-slop](https://github.com/petergyang/no-ai-slop): no praise in grading, no "here's the key
  insight", no "it's not X, it's Y", no closing one-liners, no emoji. See
  [Writing rules](#writing-rules).

## The idea

The goal is never "you can recite the fact." The goal is **understanding**: the fact is derivable
from foundations you already accept, connected to the rest of what you know, and therefore
self-preserving. Memorised facts rot. Understood facts don't.

Two principles do the work:

1. **Unconditional truths first.** Start only from things you accept as-is, with no caveats. Not
   things you are *familiar* with — things you have no objection to right now. Every later claim is
   built from those by explicit steps, so your knowledge is a graph, not a pile.
2. **"How could I have discovered this?"** Every step is motivated before it is stated. Nothing
   arrives out of nowhere.

And one process, run in order, every time:

- **Probe** — graded multiple-choice questions that bracket what you know, binary-searching for the
  ceiling. Not "do you understand?" — self-report is not measurement.
- **Plan** — a dependency graph from your actual foundations to your actual goal, presented for
  your approval before any teaching starts.
- **Teach** — one reasoning step per message, with quizzes that check whether it landed.

## Quick start

```bash
git clone https://github.com/Jujified/learn-with-claude-code.git
cd learn-with-claude-code
claude
```

Then tell it what you want to learn:

```
/teach linear algebra
```

On the first run it creates `.claude/learn.json` from the template and asks two questions: what
language to teach you in, and where to keep topic folders. Give it an absolute path to a folder
inside your Obsidian vault (for example `/Users/you/Vault/Learning`); the default is `topics/`
inside the project. After that it goes straight into the probe.

Each topic gets its own folder:

```
topics/<topic-slug>/
  log.md       ← the session, mirrored as readable Markdown (math and mermaid render natively)
  current.md   ← only your last message and the tutor's reply since, including the open question
  sources/     ← drop your own PDFs, notes and links here; they are read before the probe
  viz/         ← generated diagrams
```

`log.md` is also the system's memory. Start a new session on the same topic and the tutor reads
the log, picks up where you stopped, and does not re-teach what is already closed.

## Reading in Obsidian

Put Obsidian and the terminal side by side, with `<topic>/current.md` open in Obsidian. Each
round goes like this:

1. The tutor writes a step. The response ends there, with a hidden `<!-- quiz -->` line.
2. The log hook saves the step to `current.md` and `log.md`, then tells the tutor to ask the
   quiz. You don't type anything in between.
3. The tutor asks the question. Before it shows up in the terminal, the hook adds it to both
   files. Obsidian reloads the note, so you read the step and the question with the math rendered.
4. You pick an option in the terminal.
5. The tutor grades it and writes the next step in one response. `current.md` restarts with the
   question you just answered, your answer, the grading and the next step.

`current.md` stays short: your last message or answer and everything the tutor has said since.
`log.md` keeps the whole session. Obsidian doesn't scroll a note when it changes on disk, which is
why the short note exists.

### Why a step is split in two

The hook reads the session transcript that Claude Code writes to
`~/.claude/projects/<project>/<session>.jsonl`. Text the tutor writes **before a tool call in the
same response** is sometimes stored there as a `thinking` block holding a one-line summary instead
of a `text` block, so the full text never reaches the transcript and can't be logged. In one
session that removed the explanation from four quiz steps in a row. Text that **ends** a response
is stored reliably. So the teach skill has the tutor put learner-facing text last in every
response, and split a quiz step into a lesson response and a quiz response.

The hook (`.claude/hooks/md-log.mjs`, registered in `.claude/settings.json`) does three things:

- **`Stop`**, every time the tutor finishes a response: logs what's new. If the response ended
  with `<!-- quiz -->`, it blocks the stop and tells the tutor to ask the quiz now, which saves you
  a round trip. It does this at most twice in a row without a quiz being asked, so it can't loop.
- **`PreToolUse` on `AskUserQuestion`**, just before a question appears: logs the question.
- **Safety net.** If that same response also contains a non-empty `thinking` block (the sign of
  lost text), the hook rejects the question once and tells the tutor to resend the explanation. If
  it happens again before you reply, the question goes through with a warning callout in the note
  so you know to ask for the step again.

If nothing shows up in the vault at all, check that `.claude/learn.json` exists and has `topic`
set. Without both, the hook does nothing.

## Writing rules

The `teach` skill ends with a section called *Writing: no AI slop*, adapted from
[petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop) (MIT). That project edits drafts
you hand it; here the rules apply to the tutor's own messages. They cover:

- **Grading:** the verdict and the correct option first, then one or two sentences on why. No
  "great", "exactly", "spot on", no reassurance, no exclamation marks.
- **Banned words and phrases:** delve, leverage, robust, crucial, "let's dive in", "here's the
  key", "it's worth noting", empty adverbs like "simply" and "obviously", and the rest of the
  upstream list.
- **Banned patterns:** "it's not X, it's Y", colon reveals ("The trick: divide by $x$"),
  rhetorical questions the tutor answers itself, lines telling you what matters, closing
  aphorisms, recap paragraphs, emoji, decorative bold.
- **One term per concept:** once a word is introduced it is reused, so you never wonder whether
  "the derivative" and "the slope function" are two different things.

The tutor runs a six-question check against these rules before sending each message. The rules
apply in whatever language you're taught in.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js — for the log hook and the SVG rasteriser (no npm dependencies)
- Chrome or Edge, optional — only for rendering geometric SVG diagrams
- Obsidian, recommended. Point `topicsRoot` at a folder in your vault and lessons land there,
  fully rendered. Any Markdown reader that reloads changed files works too

## What's in the box

| Piece | File | pi original |
|---|---|---|
| Teaching philosophy and process | `.claude/skills/teach/SKILL.md` | `skills/teach/` |
| Visualisation | `.claude/skills/visualize/SKILL.md` | `skills/visualize/` |
| Fact-checking subagent | `.claude/agents/researcher.md` | `agents/researcher.md` |
| Geometric diagram subagent | `.claude/agents/svg-maker.md` | `agents/svg-maker.md` |
| SVG → PNG rasteriser | `.claude/tools/render-svg.mjs` | `extensions/visual-tools/` |
| Session → Markdown log and `current.md` | `.claude/hooks/md-log.mjs`, wired in `.claude/settings.json` | `extensions/md-log.ts` |
| Writing rules | *Writing: no AI slop* in `.claude/skills/teach/SKILL.md` | none (adapted from [no-ai-slop](https://github.com/petergyang/no-ai-slop)) |
| Local config and state | `.claude/learn.json` (git-ignored) | `/md-log` command |
| Graded quiz | `AskUserQuestion` + the quiz protocol in the `teach` skill | `extensions/quiz.ts` |
| Mermaid diagrams | Fenced ` ```mermaid ` blocks (Obsidian renders them natively) | `agents/mermaid-maker.md` |

## Configuration

`.claude/learn.json` is local to your machine and git-ignored, so your learning never ends up in a
commit. It is created from `.claude/learn.example.json` on first run.

| Key | Meaning |
|---|---|
| `language` | The language you are taught in — prose, quiz options, grading, everything |
| `topicsRoot` | Where topic folders live. Absolute (e.g. an Obsidian vault) or relative to the project |
| `topic` | The active topic slug. Changing topics is a question the tutor asks, not a silent switch |
| `labels` | Headings used inside `log.md`, so the log reads naturally in your language |
| `sessions` | Managed automatically — how much of each transcript has been mirrored. Don't edit |
| `pendingAsks`, `deniedAsks`, `quizFlow` | Managed automatically by the log hook: open questions, rejected quiz calls, and the lesson-to-quiz handoff. Don't edit |

## Teaching rules added on top of the original

Two rules added in the Claude Code port, because the evidence says the original is under-specified
rather than wrong:

- **The learner has to do the deriving.** The measured gains belong to the *learner* explaining,
  predicting and deriving (self-explanation g≈0.55, generation effect d≈0.40, productive failure
  g≈0.36). There is no evidence that an explanation merely *shaped* to feel discoverable retains
  better when read passively. So "how could I have discovered this?" pays only insofar as it makes
  you actually attempt the discovery. Two hard constraints come with it: never leave the learner
  unassisted (unguided discovery measures d = −0.38, *worse* than plain telling, against d = +0.50
  for guided), and always resolve the struggle afterwards.
- **Vary the position of the correct option.** The option-writing procedure says to write the
  correct claim first and mutate it into distractors — which, emitted in construction order, puts
  the answer at position 1 every single time. A learner spots that within three or four questions,
  and from then on position leaks the answer and the measurement is dead. This was found by a
  learner using this port, not by the model.

This fork adds the [writing rules](#writing-rules) as a third.

## Differences from the pi original

**Given up:**

- Quiz feedback arrives in the next message rather than instantly inside the popup.
- The quiz is answered in the terminal, which can't render math. Reading the question in
  `current.md` works around this.
- `AskUserQuestion` allows at most 4 options, and free text typed into its "Other" field never
  reaches the model. So "I don't know" is written as an explicit 4th option, leaving 3 real ones.
- Mermaid diagrams are not rendered and visually checked; Obsidian renders them directly. Geometric
  SVGs *are* checked — `svg-maker` rasterises to PNG and actually looks at the result.

**Gained:**

- Subagents don't depend on tmux; they run anywhere.
- `researcher` uses real web search tools.
- Setup is a clone and a launch. No extra runtime, no npm install.
- Topics are folders, so a session resumes from its own log instead of starting cold.

## Credit

- The system, the philosophy and the original implementation are
  [Eero Alvar's](https://github.com/amosblomqvist):
  [amosblomqvist/learn](https://github.com/amosblomqvist/learn). That repository carries no licence
  file; treat it as all rights reserved and check with the author before redistributing.
- The Claude Code port and the two added teaching rules are from
  [metetik/learn-with-claude-code](https://github.com/metetik/learn-with-claude-code).
- The writing rules are adapted from [petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop)
  by Peter Yang, MIT licensed.
