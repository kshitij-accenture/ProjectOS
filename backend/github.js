// github.js — GitHub API wrapper for wiki storage
// The wiki is a GitHub repo of markdown files.
// Every write is a git commit. Main branch = source of truth.

const fetch = require('node-fetch');

const BASE = 'https://api.github.com';
const OWNER = () => process.env.GITHUB_OWNER;
const REPO = () => process.env.GITHUB_REPO;
const BRANCH = () => process.env.GITHUB_BRANCH || 'main';
const TOKEN = () => process.env.GITHUB_TOKEN;

function headers() {
  return {
    'Authorization': `token ${TOKEN()}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'ProjectX-Wiki/1.0',
  };
}

// ── Read a single wiki page ───────────────────────────────────────
async function getPage(pageKey) {
  const path = `wiki/${pageKey}.md`;
  const url = `${BASE}/repos/${OWNER()}/${REPO()}/contents/${path}?ref=${BRANCH()}`;

  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read error: ${res.status}`);

  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');

  // Parse frontmatter
  const parsed = parseFrontmatter(content);
  return {
    key: pageKey,
    sha: data.sha, // Needed for updates
    path: data.path,
    ...parsed,
  };
}

// ── Write / update a wiki page (commits to GitHub) ───────────────
async function setPage(pageKey, { title, tags = [], body, authorName, authorEmail, commitMessage }) {
  const path = `wiki/${pageKey}.md`;
  const url = `${BASE}/repos/${OWNER()}/${REPO()}/contents/${path}`;

  // Build the full markdown file with frontmatter
  const updated = new Date().toISOString().slice(0, 10);
  const frontmatter = `---\ntitle: "${title}"\ntags: [${tags.map(t => `"${t}"`).join(', ')}]\nupdated: "${updated}"\nauthor: "${authorName || 'AI'}"\n---\n\n`;
  const fullContent = frontmatter + body;
  const encoded = Buffer.from(fullContent).toString('base64');

  // Check if file exists (need SHA for updates)
  const existing = await getPage(pageKey);

  const payload = {
    message: commitMessage || `Update ${pageKey} via ProjectX`,
    content: encoded,
    branch: BRANCH(),
    author: {
      name: authorName || 'ProjectX AI',
      email: authorEmail || 'projectx@accenture.com',
    },
  };
  if (existing?.sha) payload.sha = existing.sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub write error: ${res.status} — ${err.message || 'unknown'}`);
  }

  const data = await res.json();
  return {
    key: pageKey,
    sha: data.content.sha,
    commitUrl: data.commit.html_url,
    commitSha: data.commit.sha,
  };
}

// ── List all wiki pages ───────────────────────────────────────────
async function listPages() {
  const url = `${BASE}/repos/${OWNER()}/${REPO()}/contents/wiki?ref=${BRANCH()}`;
  const res = await fetch(url, { headers: headers() });

  if (res.status === 404) return []; // Wiki dir doesn't exist yet
  if (!res.ok) throw new Error(`GitHub list error: ${res.status}`);

  const files = await res.json();
  return files
    .filter(f => f.name.endsWith('.md'))
    .map(f => ({
      key: f.name.replace('.md', ''),
      path: f.path,
      sha: f.sha,
      size: f.size,
    }));
}

// ── Get commit history for a page ────────────────────────────────
async function getPageHistory(pageKey, limit = 10) {
  const path = `wiki/${pageKey}.md`;
  const url = `${BASE}/repos/${OWNER()}/${REPO()}/commits?path=${path}&per_page=${limit}&sha=${BRANCH()}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];

  const commits = await res.json();
  return commits.map(c => ({
    sha: c.sha.slice(0, 7),
    message: c.commit.message,
    author: c.commit.author.name,
    date: c.commit.author.date,
    url: c.html_url,
  }));
}

// ── Get the full index (read index.md) ───────────────────────────
async function getIndex() {
  const page = await getPage('index');
  return page ? page.body : '';
}

// ── Update the index.md after a page change ───────────────────────
async function updateIndex(allPageMetas, authorName, authorEmail) {
  const lines = ['# Wiki index\n'];
  const byTag = {};

  for (const p of allPageMetas) {
    for (const t of (p.tags || ['general'])) {
      if (!byTag[t]) byTag[t] = [];
      byTag[t].push(p);
    }
  }

  for (const [tag, pages] of Object.entries(byTag)) {
    lines.push(`\n## ${tag}\n`);
    for (const p of pages) {
      lines.push(`- [[${p.key}]] — ${p.title} _(updated ${p.updated || 'unknown'})_`);
    }
  }

  await setPage('index', {
    title: 'Wiki index',
    tags: ['meta'],
    body: lines.join('\n'),
    authorName,
    authorEmail,
    commitMessage: 'Auto-update index',
  });
}

// ── Append to log.md ─────────────────────────────────────────────
async function appendLog(entry, authorName, authorEmail) {
  const existing = await getPage('log');
  const existingBody = existing ? existing.body : '# Activity log\n';

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const newEntry = `\n## [${timestamp}] ${entry.type} | ${entry.label || ''}\n${entry.detail || ''}\n_By: ${authorName}_\n`;

  const updated = newEntry + existingBody;

  await setPage('log', {
    title: 'Activity log',
    tags: ['meta', 'log'],
    body: updated,
    authorName,
    authorEmail,
    commitMessage: `Log: ${entry.type} — ${entry.label || ''}`,
  });
}

// ── Initialise the repo with starter pages ────────────────────────
async function initRepo(authorName, authorEmail) {
  // Create wiki directory with a README
  const readme = `# ProjectX Wiki\n\nThis repository is the single source of truth for the ProjectX knowledge base.\n\nAll pages are maintained by the ProjectX AI. Do not edit files directly — use the ProjectX interface.\n\n## Structure\n- \`wiki/\` — all wiki pages as markdown files\n- \`wiki/index.md\` — auto-generated index\n- \`wiki/log.md\` — append-only activity log\n`;

  await setPage('readme', {
    title: 'ProjectX Wiki',
    tags: ['meta'],
    body: readme,
    authorName,
    authorEmail,
    commitMessage: 'Initialise ProjectX wiki',
  });
}

// ── Parse markdown frontmatter ────────────────────────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return { title: 'Untitled', tags: [], body: content, updated: null };

  const fm = match[1];
  const body = match[2];

  const titleMatch = fm.match(/title:\s*"?([^"\n]+)"?/);
  const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
  const updatedMatch = fm.match(/updated:\s*"?([^"\n]+)"?/);
  const authorMatch = fm.match(/author:\s*"?([^"\n]+)"?/);

  const tags = tagsMatch
    ? tagsMatch[1].split(',').map(t => t.trim().replace(/"/g, '')).filter(Boolean)
    : [];

  return {
    title: titleMatch ? titleMatch[1].trim() : 'Untitled',
    tags,
    updated: updatedMatch ? updatedMatch[1].trim() : null,
    author: authorMatch ? authorMatch[1].trim() : null,
    body: body.trim(),
  };
}

module.exports = {
  getPage,
  setPage,
  listPages,
  getPageHistory,
  getIndex,
  updateIndex,
  appendLog,
  initRepo,
  parseFrontmatter,
};
