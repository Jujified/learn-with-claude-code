#!/usr/bin/env node
/**
 * md-log — mirror a Claude Code teaching session into Markdown files.
 *
 * Port of the pi `md-log` extension from github.com/amosblomqvist/learn.
 *
 * Long teaching sessions are hard to read in a terminal, and markdown/math don't render there. The
 * log is meant to be read rendered (Obsidian, or any Markdown reader), so assistant text with
 * $...$ math, ```mermaid blocks and ![[embeds]] all render natively — no rendering work here.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text (the lesson itself)
 *   - AskUserQuestion Q&A blocks (the quiz protocol)
 * Tool calls (Bash, Read, Write, ...) and thinking blocks are omitted.
 *
 * Wired to two hook events, and appends only what is new each time:
 *   - PreToolUse on AskUserQuestion: fires while the question is on screen and before the learner
 *     answers, so the question and the lesson text before it are readable (math rendered) in the
 *     vault at the moment the learner has to answer.
 *   - Stop: fires after every assistant turn, to catch turns that end without a quiz.
 *
 * Two files are written to <topicsRoot>/<topic>/:
 *   - log.md      the whole session, append-only
 *   - current.md  overwritten every flush: the learner's last message and everything the tutor has
 *                 said since, so the open question is always at the top of one short note
 *
 * Config + state live in .claude/learn.json (git-ignored; see .claude/learn.example.json):
 *   {
 *     "language":    "<what the teacher teaches in>",
 *     "topicsRoot":  "<dir holding one folder per topic; absolute, or relative to the project>",
 *     "topic":       "<active topic slug, or null>",
 *     "labels":      { "user": "...", "question": "...", "answer": "..." },
 *     "sessions":    { "<session_id>": <transcript lines already consumed> },
 *     "pendingAsks": { "<tool_use_id>": "<rendered question, logged but not yet answered>" }
 *   }
 * With no config or no active topic, this hook is a no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = path.join(HERE, "..");
const PROJECT_DIR = path.join(CLAUDE_DIR, "..");
const CONFIG = path.join(CLAUDE_DIR, "learn.json");

const DEFAULT_LABELS = { user: "You", question: "Question", answer: "My answer" };

// How long PreToolUse waits for the question's tool_use line to reach the transcript.
const WAIT_MS = 2000;
const POLL_MS = 100;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let input = {};
try {
  input = JSON.parse(readStdin() || "{}");
} catch {
  process.exit(0);
}

let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
} catch {
  process.exit(0); // not configured — nothing to do
}
if (!cfg || !cfg.topic) process.exit(0); // no active topic

const root = cfg.topicsRoot || "topics";
const topicDir = path.isAbsolute(root)
  ? path.join(root, cfg.topic)
  : path.join(PROJECT_DIR, root, cfg.topic);
const logFile = path.join(topicDir, "log.md");
const currentFile = path.join(topicDir, "current.md");
const labels = { ...DEFAULT_LABELS, ...(cfg.labels || {}) };

const transcript = input.transcript_path;
const sessionId = input.session_id || "unknown";
if (!transcript || !fs.existsSync(transcript)) process.exit(0);

// The live question, when this run is the PreToolUse hook for AskUserQuestion.
const liveAsk =
  input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion"
    ? { id: input.tool_use_id || null, input: input.tool_input || {} }
    : null;

cfg.sessions = cfg.sessions || {};
const pending = new Map(
  cfg.pendingAsks && !Array.isArray(cfg.pendingAsks) ? Object.entries(cfg.pendingAsks) : [],
);
const start = cfg.sessions[sessionId] || 0;

// Only whole lines: the transcript may be mid-write, and a half line consumed now is lost for good.
function readLines() {
  let raw;
  try {
    raw = fs.readFileSync(transcript, "utf8");
  } catch {
    return null;
  }
  const end = raw.lastIndexOf("\n");
  return end < 0 ? [] : raw.slice(0, end).split("\n");
}

function hasToolUse(lines, id) {
  for (let i = lines.length - 1; i >= start; i--) {
    if (lines[i].includes(id)) return true;
  }
  return false;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let lines = readLines();
if (!lines) process.exit(0);

// Claude Code normally writes the tool_use line before running the hook. If it has not landed yet,
// wait briefly so the lesson text and the question are logged in order.
if (liveAsk?.id) {
  const deadline = Date.now() + WAIT_MS;
  while (!hasToolUse(lines, liveAsk.id) && Date.now() < deadline) {
    sleep(POLL_MS);
    lines = readLines() || lines;
  }
}

// ── rendering helpers ──────────────────────────────────────────────────────

const SKIP_USER_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<user-prompt-submit-hook>",
  "Caveat:",
];

function stripReminders(s) {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function renderQuestions(qs) {
  const parts = [];
  for (const q of qs) {
    parts.push(`\n#### ${q.header || labels.question}\n\n${q.question}\n`);
    for (const [n, o] of (q.options || []).entries()) {
      parts.push(`${n + 1}. **${o.label}**${o.description ? ` — ${o.description}` : ""}`);
    }
    parts.push("");
  }
  // Never write the correct answer here: the learner reads this file live.
  return parts.join("\n");
}

function renderAnswer(block, entry) {
  const answers = entry.toolUseResult?.answers;
  if (answers && typeof answers === "object" && Object.keys(answers).length) {
    const qs = entry.toolUseResult.questions || [];
    const vals = Object.entries(answers);
    if (vals.length === 1) return `\n**${labels.answer}:** ${vals[0][1]}\n`;
    const rows = vals.map(([q, a]) => {
      const header = qs.find((x) => x.question === q)?.header || q;
      return `- ${header}: **${a}**`;
    });
    return `\n**${labels.answer}:**\n\n${rows.join("\n")}\n`;
  }
  let body = "";
  if (typeof block.content === "string") body = block.content;
  else if (Array.isArray(block.content))
    body = block.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  // Tool result text looks like: User has answered your questions: "<question>"="<answer>". ...
  const pairs = [...body.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)].map((m) => m[2]);
  if (pairs.length === 1) return `\n**${labels.answer}:** ${pairs[0]}\n`;
  if (pairs.length > 1) return `\n**${labels.answer}:**\n\n${pairs.map((a) => `- **${a}**`).join("\n")}\n`;
  return `\n**${labels.answer}:**\n\n${body.trim()}\n`;
}

// Each item: { who: "user" | "tutor", md, question? } (question: the block an answer belongs to)
const out = [];

for (let i = start; i < lines.length; i++) {
  let e;
  try {
    e = JSON.parse(lines[i]);
  } catch {
    continue;
  }
  const msg = e.message;
  if (!msg) continue;

  // --- user prompts, and AskUserQuestion answers ---
  if (e.type === "user") {
    const c = msg.content;
    if (typeof c === "string") {
      const text = stripReminders(c);
      if (!text) continue;
      if (SKIP_USER_PREFIXES.some((p) => text.startsWith(p))) continue;
      out.push({ who: "user", md: `\n---\n\n### ${labels.user}\n\n${text}\n` });
      continue;
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type !== "tool_result") continue;
        if (!pending.has(b.tool_use_id)) continue;
        const question = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        out.push({ who: "user", md: renderAnswer(b, e), question });
      }
    }
    continue;
  }

  // --- assistant text + AskUserQuestion prompts ---
  if (e.type === "assistant" && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b.type === "text") {
        const t = (b.text || "").trim();
        if (t) out.push({ who: "tutor", md: `\n${t}\n` });
      } else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
        if (pending.has(b.id)) continue; // already logged from the hook input
        const md = renderQuestions(b.input?.questions || []);
        if (md) {
          out.push({ who: "tutor", md });
          pending.set(b.id, md);
        }
      }
    }
  }
}

// Fallback: the tool_use line never reached the transcript in time. Log the question from the hook
// input so the learner can still read it before answering.
if (liveAsk && !(liveAsk.id && pending.has(liveAsk.id))) {
  const md = renderQuestions(liveAsk.input.questions || []);
  if (md) {
    out.push({ who: "tutor", md });
    if (liveAsk.id) pending.set(liveAsk.id, md);
  }
}

if (out.length) {
  fs.mkdirSync(topicDir, { recursive: true });
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, `# ${cfg.topic}\n\n*${new Date().toISOString().slice(0, 10)}*\n`, "utf8");
  }
  fs.appendFileSync(logFile, out.map((o) => o.md).join("\n"), "utf8");

  // current.md restarts at the learner's latest message; otherwise the tutor is still talking and
  // the new text is appended. An answer keeps its question above it, so the grading that follows
  // ("option 2") can be read without the log.
  const lastUser = out.map((o) => o.who).lastIndexOf("user");
  const fresh = lastUser >= 0 || !fs.existsSync(currentFile);
  const from = Math.max(lastUser, 0);
  const tail = [out[from]?.question, ...out.slice(from).map((o) => o.md)]
    .filter(Boolean)
    .join("\n");
  if (fresh) {
    const head = `# ${cfg.topic} (current)\n\n[Full log](log.md)\n`;
    fs.writeFileSync(currentFile, `${head}\n${tail}`, "utf8");
  } else {
    fs.appendFileSync(currentFile, tail, "utf8");
  }
}

cfg.sessions[sessionId] = Math.max(start, lines.length);
cfg.pendingAsks = Object.fromEntries(pending);
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
process.exit(0);
