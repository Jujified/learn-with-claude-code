---
name: visualize
description: Add a correct, minimal visual to a lesson — a diagram or geometric picture — that renders inline in the Obsidian log. Use when an idea is genuinely clearer as a picture: a dependency graph, system/flow, sequence, state machine, tree, comparison, or a spatial/geometric thing (coordinate geometry, number line, vectors, a plot, a physical layout).
---

# Visualize

A picture earns its place only when it shows something words can't — shape, structure, direction,
relationship, geometry. This skill produces ONE such picture and drops it into the lesson so it
renders inline in the Obsidian log file.

## When to visualize (and when not to)

This teaching system builds a **dependency graph in the learner's head** — unconditional truths at
the root, derived facts hanging off them. A visual is powerful exactly when it makes that structure
(or a geometry) visible. Reach for one when:

- The idea is a **structure or relationship**: dependencies, a system with parts and arrows, a
  flow/pipeline, a sequence of exchanges, a state machine, a tree/hierarchy, a comparison, a
  containment.
- The idea is **spatial or geometric**: coordinate geometry, a number line, vectors, a function's
  shape, a physical arrangement.

Do NOT visualize when prose or a single equation already carries it. A decorative diagram that just
restates the sentence next to it adds noise and a chance to be wrong. When in doubt, don't — a
missing visual is cheaper than a false one.

## Two paths

### Path A — structural/relational: write mermaid inline (default)

Obsidian renders fenced ` ```mermaid ` blocks natively, and the `md-log` hook mirrors your message
text verbatim, so a mermaid block you write in chat renders as a diagram in the log with no
rendering step and no subagent. Use this for dependency graphs, flowcharts, sequence/state/ER/class
diagrams, trees, mindmaps, timelines. This is the default and fits the dependency-graph pedagogy
directly.

Rules:
- `graph TD` with foundations at the top flowing down to conclusions is usually the right shape.
- **Few nodes, short labels.** If you're about to draw more than ~7 nodes, simplify. Cramming is the
  number-one way these fail. A node holds a term or short phrase, never a sentence.
- Every arrow must be *true*. A wrong dependency edge teaches a wrong dependency.
- Avoid characters mermaid chokes on inside labels — parentheses, quotes and `$` need quoting:
  write `A["f(x)"]`, not `A[f(x)]`.

### Path B — spatial/geometric: dispatch `svg-maker`

Mermaid cannot lay out exact coordinates. For geometry figures, number lines, vectors, function
plots, physical layouts and custom shapes, dispatch the maker subagent:

```
Agent(subagent_type: "svg-maker", prompt: "<your minimal, concrete brief>")
```

It authors the SVG, renders it to PNG, **looks at the PNG** and iterates until the geometry is
actually correct, saves both into the vault's `viz/` folder and returns a filename. You then embed
it in your teaching message with Obsidian's wikilink embed:

```
![[viz-<slug>-<timestamp>.png|500]]
```

Use the returned **filename**, not the full path — Obsidian resolves embeds by filename anywhere in
the vault. Width `|500` is a good default; larger for dense figures.

Call `svg-maker` with no lesson text before the call, then write the step with the embed after it
returns. Text written before a tool call can fail to reach the log (see *Response shape* in the
`teach` skill).

If it returns `RESULT: NONE`, it couldn't make a correct picture of the brief — simplify, rethink,
or decide the visual isn't worth it. Never hand-author a geometric figure yourself and pass it off
as verified; correctness there depends on the render-and-inspect loop.

## Brief the maker well: one idea, fewest elements

The most common failure is **cramming** — every extra label makes the picture harder to read AND
harder to lay out correctly. Before briefing, prune to the fewest elements that carry the idea, and
for each ask: *"if I delete this, is the idea still clear?"* If yes, delete it.

Give the maker the concept AND the concrete elements you want — not a vague topic, and not a long
checklist.

- BAD: "make a diagram about how TCP works"
- GOOD: "graph TD: a node 'packet' at the top; arrows down to 'ordering' and 'retransmit on loss';
  both arrows down into 'reliable stream'. No title. Show that reliability is built FROM packets,
  not alongside them."

If your brief lists more than ~5–7 elements, cut it first.

## Presenting it

Introduce the visual in a sentence, then let it carry the idea — don't narrate every element back in
prose. The picture is there to do work the prose can't.
