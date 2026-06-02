// ai.js — Anthropic API wrapper
// All Claude calls are proxied through the backend.
// Users never touch the API key — it lives only in the server environment.

const fetch = require('node-fetch');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

async function callClaude(systemPrompt, userMessage, maxTokens = 1500) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${res.status}`);
  }

  const data = await res.json();
  return data.content.map(b => b.text || '').join('');
}

// ── Command bar — answer a question using the wiki ────────────────
async function runCommand(question, wikiSummary, role, userName) {
  const system = `You are the AI engine for ProjectX, an AI-native project operating system for Accenture's Diageo engagement.

Current user: ${userName} (role: ${role})

Wiki summary:
${wikiSummary}

You help with: drafting steerco updates, summarising risks, answering questions about projects, and maintaining the wiki.

Rules:
- Be direct, specific, and consulting-grade. No filler.
- For exec role: keep answers to 3 sentences max, focus on decisions and risks only.
- For team role: focus only on their project.
- If asked to update or create a wiki page, return ONLY a JSON block:
  {"action":"update_wiki","page":"page-key","title":"Page Title","body":"...full markdown..."}
- Otherwise respond in clean markdown.
- Never invent facts. If unsure, say so.`;

  return callClaude(system, question, 1500);
}

// ── Ingest — process a source and update wiki pages ───────────────
async function runIngest(label, content, existingWikiIndex, role) {
  const system = `You are the wiki maintenance engine for ProjectX. Process this source and update the knowledge base.

Existing wiki pages:
${existingWikiIndex}

Instructions:
1. Extract decisions, risks, blockers, actions, insights from the source
2. Identify which pages need updating (or creating)
3. Return ONLY valid JSON in this exact structure:
{
  "summary": "2-3 sentence summary",
  "updates": [
    {"page": "page-key", "title": "Page Title", "body": "complete updated markdown — preserve existing content, integrate new info"}
  ],
  "new_pages": [
    {"page": "new-slug", "title": "New Page Title", "body": "full markdown content"}
  ]
}

Rules:
- page keys are lowercase-hyphenated slugs (e.g. "mia-risks", "tequila-decisions")
- preserve ALL existing content in updated pages — integrate, don't replace
- be thorough — a single source can touch 5-10 pages
- never invent data not present in the source
- Return ONLY valid JSON, no preamble or explanation`;

  const result = await callClaude(system, `Source: ${label}\n\nContent:\n${content}`, 3000);
  const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

// ── Quick update — integrate a short note into a page ─────────────
async function runQuickUpdate(pageTitle, pageBody, update) {
  const system = `You are maintaining a wiki page for ProjectX. Integrate the user's update naturally into the existing content.
Return ONLY the complete updated markdown body (no frontmatter, no explanation).
Preserve all existing content. Add the update in the most logical place.`;

  return callClaude(system,
    `Page: "${pageTitle}"\n\nExisting content:\n${pageBody}\n\n---\nUpdate to integrate: ${update}`,
    2000);
}

// ── Lint — health check the wiki ──────────────────────────────────
async function runLint(wikiDump) {
  const system = `You are a wiki health auditor for ProjectX. Review the wiki and identify:
- Contradictions between pages
- Stale claims that may be outdated
- Orphan pages with no cross-references
- Missing cross-references between related pages
- Important gaps (topics mentioned but lacking their own page)
- Suggested new sources to investigate

Format as a clear markdown list with specific page names and actionable recommendations.`;

  return callClaude(system, `Wiki contents:\n${wikiDump}`, 1500);
}

// ── Executive digest — generate a curated exec summary ───────────
async function generateExecDigest(wikiDump) {
  const system = `You are generating a weekly executive digest for senior leadership (Piyush Manocha, Accenture MD).

Format: clean markdown, 3 sections maximum:
1. **Status** — 2-3 sentences on overall health across all projects
2. **Decisions required** — bullet list of decisions needing leadership input
3. **Risks requiring attention** — top 3 risks only, with recommended action

Rules:
- No operational detail. Decision-oriented only.
- Max 250 words total.
- Be direct. No hedging.`;

  return callClaude(system, `Wiki contents:\n${wikiDump}`, 600);
}

module.exports = {
  callClaude,
  runCommand,
  runIngest,
  runQuickUpdate,
  runLint,
  generateExecDigest,
};
