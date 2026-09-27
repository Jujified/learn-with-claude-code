#!/usr/bin/env node
/**
 * md-log — mirror a Claude Code teaching session into Markdown files, and keep lesson text from
 * getting lost before a quiz.
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
 * Tool calls (Bash, Read, Write, ...), thinking blocks and harness-injected messages are omitted.
 *
 * Wired to two hook events, and appends only what is new each time:
 *   - PreToolUse on AskUserQuestion: fires before the question appears in the terminal, so the
 *     question is readable (math rendered) in the vault while the learner decides.
 *   - Stop: fires every time the tutor finishes a response.
 *
 * The quiz handoff. Text written before a tool call in the same response is sometimes stored in
 * the transcript as a thinking block holding a one-line summary instead of a text block. The full
 * text never reaches the transcript, so it can't be logged. Text that ends a response is stored
 * reliably. So the teach skill splits a quiz step in two:
 *   1. A response that ends with the lesson text and a last line `<!-- quiz -->`.
 *   2. A response that opens with the AskUserQuestion call and has no text before it.
 * On Stop, when the response ended with the marker, this hook logs the text and blocks the stop
 * with a reason telling the tutor to ask the quiz now, so there is no extra round trip for the
 * learner. As a safety net, PreToolUse rejects (once) a quiz whose own response contains a
 * non-empty thinking block, which is how lost text shows up, and tells the tutor to resend it.
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
 *     "pendingAsks": { "<tool_use_id>": "<rendered question, logged but not yet answered>" },
 *     "deniedAsks":  [ "<tool_use_id of a quiz call this hook rejected>" ],
 *     "quizFlow":    { "awaiting", "nudgedAt", "nudges", "denials" }   (see below)
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

// The line the tutor ends a lesson response with when a quiz comes next.
const QUIZ_MARKER = /<!--\s*quiz\s*-->/i;
const QUIZ_MARKER_ALL = /[ \t]*<!--\s*quiz\s*-->[ \t]*\n?/gi;

// Stop blocks at most this many times in a row without a quiz being asked, so a confused tutor
// can't loop.
const MAX_NUDGES = 2;
// PreToolUse rejects a quiz with lost text at most this many times per learner message.
const MAX_DENIALS = 1;

const NUDGE_REASON =
  "The lesson text is saved to the learner's notes. Ask this step's quiz now: call " +
  "AskUserQuestion as the first thing in your response, with no text before it.";

const DENY_REASON =
  "Not asked. The text you wrote before this question in the same response was not saved to " +
  "the transcript (it was stored as a thinking summary), so the learner's notes are missing the " +
  "explanation the question depends on. Resend that text as the whole of your next response and " +
  "end it with a last line `<!-- quiz -->`, with no tool call after it. You will then be told to " +
  "ask the question. If you wrote no text before this question, call AskUserQuestion again " +
  "unchanged.";

const LOST_WARNING =
  "\n> [!warning] Missing explanation\n> The tutor's text before this question was not saved. " +
  "Ask it to repeat the step before you answer.\n";

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

const event = input.hook_event_name;

// The live question, when this run is the PreToolUse hook for AskUserQuestion.
const liveAsk =
  event === "PreToolUse" && input.tool_name === "AskUserQuestion"
    ? { id: input.tool_use_id || null, input: input.tool_input || {} }
    : null;

cfg.sessions = cfg.sessions || {};
const pending = new Map(
  cfg.pendingAsks && !Array.isArray(cfg.pendingAsks) ? Object.entries(cfg.pendingAsks) : [],
);
const denied = new Set(Array.isArray(cfg.deniedAsks) ? cfg.deniedAsks : []);
// awaiting: the tutor was just told to ask a quiz (no learner message or quiz since)
// nudgedAt: "<session>:<line>" of the marker response Stop last acted on
// nudges:   Stop blocks since the last quiz or learner message
// denials:  quiz calls rejected since the last learner message
const flow = { awaiting: false, nudgedAt: null, nudges: 0, denials: 0, ...(cfg.quizFlow || {}) };
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

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// The transcript line holding the assistant's tool_use block with this id (not its tool_result).
function findLine(lines, id) {
  const needle = `"id":"${id}"`;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(needle)) continue;
    const e = parse(lines[i]);
    if (e?.type === "assistant" && e.message?.content?.some((b) => b.type === "tool_use" && b.id === id))
      return i;
  }
  return -1;
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
  while (findLine(lines, liveAsk.id) < start && Date.now() < deadline) {
    sleep(POLL_MS);
    lines = readLines() || lines;
  }
}

// True when the response carrying this tool_use also carries a non-empty thinking block before it:
// the sign that text written there was stored as a summary and lost.
function lostTextBefore(id) {
  const at = findLine(lines, id);
  const e = at >= 0 ? parse(lines[at]) : null;
  const msgId = e?.message?.id;
  if (!msgId) return false;
  // Blocks of one response may share a line or sit on consecutive lines with the same message id.
  const blocks = [];
  for (let j = at; j >= 0; j--) {
    const x = j === at ? e : parse(lines[j]);
    if (!x || x.type !== "assistant" || x.message?.id !== msgId) break;
    blocks.unshift(...(x.message.content || []));
  }
  for (const b of blocks) {
    if (b.type === "tool_use" && b.id === id) return false;
    if (b.type === "thinking" && (b.thinking || "").trim()) return true;
  }
  return false;
}

// Decide whether the live quiz call may run. Returns "allow", "warn" (allow, flag in the log) or
// "deny".
function decide(id) {
  if (!lostTextBefore(id)) return "allow";
  if (flow.awaiting) return "allow"; // the lesson was logged just before; nothing depended on it
  if (flow.denials >= MAX_DENIALS) return "warn";
  flow.denials++;
  return "deny";
}

// ── rendering helpers ──────────────────────────────────────────────────────

const SKIP_USER_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<user-prompt-submit-hook>",
  "Stop hook feedback:",
  "Caveat:",
  "[Request interrupted",
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

// A typed learner message, or null for anything the harness injected.
function promptText(e) {
  if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return null;
  const c = e.message.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === "tool_result")) return null;
    text = c.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
  }
  text = stripReminders(text);
  if (!text || SKIP_USER_PREFIXES.some((p) => text.startsWith(p))) return null;
  return text;
}

// ── scan the new part of the transcript ─────────────────────────────────────

// Each item: { who: "user" | "tutor", md, question? } (question: the block an answer belongs to)
const out = [];
let decision = null; // for the live quiz call

function learnerSpoke() {
  flow.awaiting = false;
  flow.nudges = 0;
  flow.denials = 0;
}

function logAsk(id, qs, warn) {
  const md = renderQuestions(qs);
  if (!md) return;
  out.push({ who: "tutor", md: (warn ? LOST_WARNING : "") + md });
  if (id) pending.set(id, md);
  flow.awaiting = false;
  flow.nudges = 0;
}

for (let i = start; i < lines.length; i++) {
  const e = parse(lines[i]);
  const msg = e?.message;
  if (!msg) continue;

  // --- user prompts, and AskUserQuestion answers ---
  if (e.type === "user") {
    const text = promptText(e);
    if (text) {
      out.push({ who: "user", md: `\n---\n\n### ${labels.user}\n\n${text}\n` });
      learnerSpoke();
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== "tool_result") continue;
        if (!pending.has(b.tool_use_id)) continue;
        const question = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        out.push({ who: "user", md: renderAnswer(b, e), question });
        learnerSpoke();
      }
    }
    continue;
  }

  // --- assistant text + AskUserQuestion prompts ---
  if (e.type === "assistant" && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b.type === "text") {
        const t = (b.text || "").replace(QUIZ_MARKER_ALL, "").trim();
        if (t) out.push({ who: "tutor", md: `\n${t}\n` });
      } else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
        if (pending.has(b.id) || denied.has(b.id)) continue;
        let warn = false;
        if (liveAsk && b.id === liveAsk.id) {
          decision = decide(b.id);
          if (decision === "deny") {
            denied.add(b.id);
            continue;
          }
          warn = decision === "warn";
        }
        logAsk(b.id, b.input?.questions || [], warn);
      }
    }
  }
}

// Fallback: the tool_use line never reached the transcript in time. Log the question from the hook
// input so the learner can still read it before answering.
if (liveAsk && !decision && !(liveAsk.id && (pending.has(liveAsk.id) || denied.has(liveAsk.id)))) {
  decision = "allow";
  logAsk(liveAsk.id, liveAsk.input.questions || [], false);
}

// ── Stop: hand off to the quiz when the response ended with the marker ─────────

let stopOutput = null;
if (event === "Stop") {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (e?.type === "assistant") {
      last = i;
      break;
    }
    if (e?.type === "user") break; // the learner spoke after the tutor's last response
  }
  const e = last >= 0 ? parse(lines[last]) : null;
  const blocks = e?.message?.content || [];
  const tail = blocks[blocks.length - 1];
  const key = `${sessionId}:${last}`;
  if (
    tail?.type === "text" &&
    QUIZ_MARKER.test(tail.text || "") &&
    flow.nudgedAt !== key &&
    flow.nudges < MAX_NUDGES
  ) {
    flow.nudgedAt = key;
    flow.nudges++;
    flow.awaiting = true;
    stopOutput = { decision: "block", reason: NUDGE_REASON };
  } else {
    flow.awaiting = false; // the tutor stopped without handing off to a quiz
  }
}

// ── write ──────────────────────────────────────────────────────────────────

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
cfg.deniedAsks = [...denied].slice(-50);
cfg.quizFlow = flow;
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");

if (decision === "deny") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: DENY_REASON,
      },
    }),
  );
} else if (stopOutput) {
  process.stdout.write(JSON.stringify(stopOutput));
}
process.exit(0);
