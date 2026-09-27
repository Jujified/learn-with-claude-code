# learn-with-claude-code

A one-on-one AI tutor that refuses to let you memorise things.

This is a Claude Code port of [amosblomqvist/learn](https://github.com/amosblomqvist/learn)
by [Eero Alvar](https://github.com/amosblomqvist) ([video](https://youtu.be/kzcI5F4tGiU)), built for
[pi](https://github.com/pi-labs-ai/pi) with custom extensions. The teaching philosophy is his; this
repository rebuilds it on Claude Code's own mechanisms — skills, subagents and hooks — so it runs
anywhere Claude Code runs, with no extra runtime.

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
git clone https://github.com/metetik/learn-with-claude-code.git
cd learn-with-claude-code
claude
```

Then tell it what you want to learn:

```
/teach linear algebra
```

On the first run it creates `.claude/learn.json` from the template and asks two questions: what
language to teach you in, and where to keep topic folders (a folder inside your Obsidian vault, or
the default `topics/` inside the project). After that it goes straight into the probe.

Each topic gets its own folder:

```
topics/<topic-slug>/
  log.md       ← the session, mirrored as readable Markdown (math and mermaid render natively)
  current.md   ← only your last message and the tutor's reply since, including the open question
  sources/     ← drop your own PDFs, notes and links here; they are read before the probe
  viz/         ← generated diagrams
```

Both files update while the tutor is waiting for your answer, not after it: the log hook runs
just before every quiz question appears in the terminal, and again at the end of every turn. Keep
`current.md` open in Obsidian next to the terminal: read the question there with the math rendered,
answer in the terminal.

`log.md` is also the system's memory: start a new session on the same topic and it reads the log,
picks up where you stopped, and does not re-teach what is already closed.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js — for the log hook and the SVG rasteriser (no npm dependencies)
- Chrome or Edge, optional — only for rendering geometric SVG diagrams
- Obsidian, optional — point `topicsRoot` at your vault and lessons land there, fully rendered

## What's in the box

| Piece | File | pi original |
|---|---|---|
| Teaching philosophy and process | `.claude/skills/teach/SKILL.md` | `skills/teach/` |
| Visualisation | `.claude/skills/visualize/SKILL.md` | `skills/visualize/` |
| Fact-checking subagent | `.claude/agents/researcher.md` | `agents/researcher.md` |
| Geometric diagram subagent | `.claude/agents/svg-maker.md` | `agents/svg-maker.md` |
| SVG → PNG rasteriser | `.claude/tools/render-svg.mjs` | `extensions/visual-tools/` |
| Session → Markdown log | `.claude/hooks/md-log.mjs` (`PreToolUse` on `AskUserQuestion` + `Stop`) | `extensions/md-log.ts` |
| Writing rules (no AI slop) | *Writing: no AI slop* in `.claude/skills/teach/SKILL.md` | none; adapted from [petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop) |
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
| `pendingAsks` | Managed automatically — quiz questions already logged whose answers haven't arrived. Don't edit |

## What this port adds

Three rules that are not in the original. The first two were added because the evidence says the
original is under-specified rather than wrong:

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
- **No AI slop.** The tutor's prose follows writing rules adapted from Peter Yang's
  [no-ai-slop](https://github.com/petergyang/no-ai-slop) (MIT): no praise or consolation in grading,
  no "here's the key insight" setups, no "it's not X, it's Y", no colon reveals, no closing
  aphorisms, no emoji, one term per concept. The skill has the full list and a check the tutor runs
  before every message.

## Differences from the pi original

**Given up:**

- Quiz feedback arrives in the next message rather than instantly inside the popup.
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

The system, the philosophy and the original implementation are
[Eero Alvar's](https://github.com/amosblomqvist) — see
[amosblomqvist/learn](https://github.com/amosblomqvist/learn). This fork ports it to a different
runtime and adds the rules above. The writing rules are adapted from
[petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop) by Peter Yang, MIT licensed. The upstream repository carries no licence file; treat it as
all rights reserved and check with the author before redistributing.
