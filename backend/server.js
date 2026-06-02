// server.js — ProjectX backend
// Express + Passport (Microsoft SSO + Google OAuth)
// GitHub wiki storage + Anthropic AI proxy

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { resolveRole, canReadPage, canWritePage, canUseAI, canIngest, canLint, uiConfig } = require('./access');
const github = require('./github');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP handled separately
app.use(cors({ origin: process.env.BASE_URL, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // 20 AI requests per minute per IP
  message: { error: 'Too many requests — slow down.' },
});

// ── Session ───────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ── Passport ──────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Microsoft SSO
if (process.env.MICROSOFT_CLIENT_ID) {
  passport.use(new MicrosoftStrategy({
    clientID: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/microsoft/callback`,
    tenant: process.env.MICROSOFT_TENANT_ID || 'common',
    scope: ['user.read'],
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || profile._json?.mail || profile._json?.userPrincipalName || '';
    const user = {
      id: profile.id,
      name: profile.displayName,
      email: email.toLowerCase(),
      provider: 'microsoft',
      role: resolveRole(email),
    };
    if (user.role === 'denied') return done(null, false, { message: 'Access denied.' });
    return done(null, user);
  }));
}

// Google OAuth
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || '';
    const user = {
      id: profile.id,
      name: profile.displayName,
      email: email.toLowerCase(),
      provider: 'google',
      role: resolveRole(email),
    };
    if (user.role === 'denied') return done(null, false, { message: 'Access denied.' });
    return done(null, user);
  }));
}

// ── Auth middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login.html');
}

// ── Auth routes ───────────────────────────────────────────────────
app.get('/auth/microsoft', passport.authenticate('microsoft'));
app.get('/auth/microsoft/callback',
  passport.authenticate('microsoft', { failureRedirect: '/login.html?error=denied' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html?error=denied' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/login.html'));
});

// ── Session info ──────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json(uiConfig(req.user.role, req.user.email, req.user.name));
});

// ── Wiki API ──────────────────────────────────────────────────────

// List pages the current user can read
app.get('/api/wiki', requireAuth, async (req, res) => {
  try {
    const pages = await github.listPages();
    const accessible = pages.filter(p => canReadPage(req.user.role, req.user.email, p.key));
    res.json(accessible);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single page
app.get('/api/wiki/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  if (!canReadPage(req.user.role, req.user.email, key)) {
    return res.status(403).json({ error: 'Access denied to this page.' });
  }
  try {
    const page = await github.getPage(key);
    if (!page) return res.status(404).json({ error: 'Page not found.' });
    res.json(page);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get page history (git commits)
app.get('/api/wiki/:key/history', requireAuth, async (req, res) => {
  const { key } = req.params;
  if (!canReadPage(req.user.role, req.user.email, key)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  try {
    const history = await github.getPageHistory(key);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a page (commits to GitHub)
app.put('/api/wiki/:key', requireAuth, aiLimiter, async (req, res) => {
  const { key } = req.params;
  if (!canWritePage(req.user.role, req.user.email, key)) {
    return res.status(403).json({ error: 'You do not have write access to this page.' });
  }
  const { title, tags, body, commitMessage } = req.body;
  try {
    const result = await github.setPage(key, {
      title, tags, body,
      authorName: req.user.name,
      authorEmail: req.user.email,
      commitMessage: commitMessage || `Update ${key}`,
    });
    await github.appendLog(
      { type: 'edit', label: title || key, detail: commitMessage || '' },
      req.user.name, req.user.email
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI API ────────────────────────────────────────────────────────

// Command bar — ask anything
app.post('/api/ai/command', requireAuth, aiLimiter, async (req, res) => {
  if (!canUseAI(req.user.role)) {
    return res.status(403).json({ error: 'AI commands are not available for your access level.' });
  }
  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'No question provided.' });

  try {
    const pages = await github.listPages();
    const readableKeys = pages
      .filter(p => canReadPage(req.user.role, req.user.email, p.key))
      .map(p => p.key);

    const wikiChunks = [];
    for (const key of readableKeys.slice(0, 15)) { // Cap at 15 pages for context
      const page = await github.getPage(key).catch(() => null);
      if (page) wikiChunks.push(`[${key}] ${page.title}:\n${page.body.slice(0, 400)}`);
    }

    const result = await ai.runCommand(question, wikiChunks.join('\n\n'), req.user.role, req.user.name);

    // Handle wiki update actions
    const jsonMatch = result.match(/\{"action":"update_wiki"[\s\S]*?\}/);
    if (jsonMatch) {
      const action = JSON.parse(jsonMatch[0]);
      if (canWritePage(req.user.role, req.user.email, action.page)) {
        await github.setPage(action.page, {
          title: action.title,
          tags: ['ai-updated'],
          body: action.body,
          authorName: req.user.name,
          authorEmail: req.user.email,
          commitMessage: `AI command: update ${action.page}`,
        });
        return res.json({ type: 'wiki_update', page: action.page, title: action.title, message: `Wiki page "${action.title}" updated.` });
      }
    }

    await github.appendLog({ type: 'command', label: question.slice(0, 60) }, req.user.name, req.user.email);
    res.json({ type: 'text', content: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ingest a new source
app.post('/api/ai/ingest', requireAuth, aiLimiter, async (req, res) => {
  if (!canIngest(req.user.role)) {
    return res.status(403).json({ error: 'Ingest is not available for your access level.' });
  }
  const { label, content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'No content provided.' });

  try {
    const pages = await github.listPages();
    const index = pages.map(p => `${p.key}`).join(', ');

    const parsed = await ai.runIngest(label, content, index, req.user.role);

    const committed = [];
    for (const upd of [...(parsed.updates || []), ...(parsed.new_pages || [])]) {
      if (canWritePage(req.user.role, req.user.email, upd.page)) {
        await github.setPage(upd.page, {
          title: upd.title,
          tags: ['ai-updated'],
          body: upd.body,
          authorName: req.user.name,
          authorEmail: req.user.email,
          commitMessage: `Ingest: ${label} → ${upd.page}`,
        });
        committed.push(upd.page);
      }
    }

    await github.appendLog({
      type: 'ingest',
      label,
      detail: `${committed.length} pages updated: ${committed.join(', ')}`,
    }, req.user.name, req.user.email);

    res.json({ summary: parsed.summary, pagesUpdated: committed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick update a page
app.post('/api/ai/quick-update/:key', requireAuth, aiLimiter, async (req, res) => {
  const { key } = req.params;
  if (!canWritePage(req.user.role, req.user.email, key)) {
    return res.status(403).json({ error: 'No write access to this page.' });
  }
  const { update } = req.body;
  try {
    const page = await github.getPage(key);
    if (!page) return res.status(404).json({ error: 'Page not found.' });

    const newBody = await ai.runQuickUpdate(page.title, page.body, update);
    await github.setPage(key, {
      ...page,
      body: newBody,
      authorName: req.user.name,
      authorEmail: req.user.email,
      commitMessage: `Quick update: ${update.slice(0, 60)}`,
    });

    res.json({ success: true, key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lint the wiki
app.post('/api/ai/lint', requireAuth, aiLimiter, async (req, res) => {
  if (!canLint(req.user.role)) {
    return res.status(403).json({ error: 'Wiki lint is only available to delivery leads.' });
  }
  try {
    const pages = await github.listPages();
    const chunks = [];
    for (const p of pages.slice(0, 20)) {
      const page = await github.getPage(p.key).catch(() => null);
      if (page) chunks.push(`## ${p.key}: ${page.title}\n${page.body.slice(0, 300)}`);
    }
    const result = await ai.runLint(chunks.join('\n\n'));
    res.json({ content: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Executive digest
app.get('/api/ai/exec-digest', requireAuth, aiLimiter, async (req, res) => {
  try {
    const pages = await github.listPages();
    const chunks = [];
    for (const p of pages.filter(p => !['log','index'].includes(p.key)).slice(0, 10)) {
      const page = await github.getPage(p.key).catch(() => null);
      if (page) chunks.push(`## ${page.title}\n${page.body.slice(0, 500)}`);
    }
    const digest = await ai.generateExecDigest(chunks.join('\n\n'));

    // Write it back as the exec-digest page
    await github.setPage('exec-digest', {
      title: 'Executive digest',
      tags: ['exec', 'digest'],
      body: digest,
      authorName: 'ProjectX AI',
      authorEmail: 'projectx@accenture.com',
      commitMessage: `Auto-generate exec digest ${new Date().toISOString().slice(0,10)}`,
    });

    res.json({ content: digest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// Protect the main app
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/app.html'));
});

// Login page is public
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ProjectX running on ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`GitHub wiki: ${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`);
});
