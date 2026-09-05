#!/usr/bin/env node
/**
 * md-log — mirror a Claude Code teaching session into a Markdown file.
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
 * Wired as a Stop hook, so it runs after every assistant turn and appends only what is new.
 * Config + state live in .claude/learn.json (git-ignored; see .claude/learn.example.json):
 *   {
 *     "language":   "<what the teacher teaches in>",
 *     "topicsRoot": "<dir holding one folder per topic; absolute, or relative to the project>",
 *     "topic":      "<active topic slug, or null>",
 *     "labels":     { "user": "...", "question": "...", "answer": "..." },
 *     "sessions":   { "<session_id>": <transcript lines already consumed> }
 *   }
 * The log is written to <topicsRoot>/<topic>/log.md. With no config or no active topic, this
 * hook is a no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = path.join(HERE, "..");
const PROJECT_DIR = path.join(CLAUDE_DIR, "..");
const CONFIG = path.join(CLAUDE_DIR, "learn.json");

const DEFAULT_LABELS = { user: "You", question: "Question", answer: "My answer" };

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
const target = path.join(topicDir, "log.md");
const labels = { ...DEFAULT_LABELS, ...(cfg.labels || {}) };

const transcript = input.transcript_path;
const sessionId = input.session_id || "unknown";
if (!transcript || !fs.existsSync(transcript)) process.exit(0);

let lines;
try {
  lines = fs.readFileSync(transcript, "utf8").split(/\r?\n/).filter((l) => l.trim());
} catch {
  process.exit(0);
}

cfg.sessions = cfg.sessions || {};
const start = cfg.sessions[sessionId] || 0;
if (start >= lines.length) process.exit(0);

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

const out = [];
const pendingAsk = new Map(); // tool_use_id -> questions[]

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
      out.push(`\n---\n\n### 🧑 ${labels.user}\n\n${text}\n`);
      continue;
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type !== "tool_result") continue;
        if (!pendingAsk.has(b.tool_use_id)) continue;
        pendingAsk.delete(b.tool_use_id);
        let body = "";
        if (typeof b.content === "string") body = b.content;
        else if (Array.isArray(b.content))
          body = b.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
        out.push(`\n**${labels.answer}:**\n\n${body.trim()}\n`);
      }
    }
    continue;
  }

  // --- assistant text + AskUserQuestion prompts ---
  if (e.type === "assistant" && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b.type === "text") {
        const t = (b.text || "").trim();
        if (t) out.push(`\n${t}\n`);
      } else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
        const qs = b.input?.questions || [];
        const parts = [];
        for (const q of qs) {
          parts.push(`\n#### ❓ ${q.header || labels.question}\n\n${q.question}\n`);
          for (const [n, o] of (q.options || []).entries()) {
            parts.push(`${n + 1}. **${o.label}**${o.description ? ` — ${o.description}` : ""}`);
          }
          parts.push("");
        }
        // Never write the correct answer here: the learner reads this file live.
        if (parts.length) {
          out.push(parts.join("\n"));
          pendingAsk.set(b.id, qs);
        }
      }
    }
  }
}

if (out.length) {
  fs.mkdirSync(topicDir, { recursive: true });
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, `# ${cfg.topic}\n\n*${new Date().toISOString().slice(0, 10)}*\n`, "utf8");
  }
  fs.appendFileSync(target, out.join("\n"), "utf8");
}

cfg.sessions[sessionId] = lines.length;
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
process.exit(0);
