# ProjectX — Deployment Guide

## What you're deploying

A Node.js app on Railway that:
- Serves the HTML frontend
- Handles Microsoft SSO login
- Proxies all AI calls to Anthropic (one API key, server-side)
- Reads and writes the wiki as git commits to a GitHub repo
- Enforces role-based access per user email

---

## Step 1 — Create the GitHub wiki repo

1. Go to github.com → New repository
2. Name it `projectx-wiki`
3. Make it **private**
4. Initialise with a README
5. Create a `wiki/` folder (add a placeholder file)
6. Generate a Personal Access Token:
   - GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Repository access: `projectx-wiki` only
   - Permissions: Contents (read + write)
   - Copy the token → this is your `GITHUB_TOKEN`

---

## Step 2 — Register Microsoft Azure app

This gives you one-click sign-in for Accenture accounts.

1. Go to portal.azure.com → Azure Active Directory → App registrations → New registration
2. Name: `ProjectX`
3. Supported account types: **Accounts in this organizational directory only** (Accenture tenant)
   - Or "Multitenant" if you want Diageo accounts too
4. Redirect URI: `https://your-railway-domain.up.railway.app/auth/microsoft/callback`
5. After creating → Certificates & secrets → New client secret → copy the value
6. Copy the Application (client) ID and Directory (tenant) ID from the Overview page

---

## Step 3 — Deploy to Railway

Railway is free to start and takes about 5 minutes.

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# In the projectx/ directory
railway init
railway up
```

Or via the Railway dashboard:
1. railway.app → New project → Deploy from GitHub repo
2. Connect this repo
3. Railway auto-detects Node.js and runs `npm start`

---

## Step 4 — Set environment variables on Railway

In Railway dashboard → your project → Variables, add:

```
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-github-username
GITHUB_REPO=projectx-wiki
GITHUB_BRANCH=main
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=...
SESSION_SECRET=generate-a-long-random-string
BASE_URL=https://your-railway-domain.up.railway.app
NODE_ENV=production
EXEC_EMAILS=piyush.manocha@accenture.com,josh.naffman@diageo.com
LEAD_EMAILS=avishek.saha@accenture.com
DIAGEO_EMAILS=sud@diageo.com,ian.curd@diageo.com
ALLOWED_DOMAINS=accenture.com,diageo.com
```

---

## Step 5 — Update Azure redirect URI

After Railway gives you a URL, go back to Azure → App registrations → ProjectX → Authentication
→ Add the redirect URI: `https://your-railway-domain.up.railway.app/auth/microsoft/callback`

---

## Step 6 — Initialise the wiki

The first delivery lead to log in should run from the command bar:
`"Initialise the wiki with the MIA handoff note"`

Or directly via the ingest panel.

---

## Access levels (set via environment variables)

| Role | How assigned | What they see |
|------|-------------|---------------|
| Executive | `EXEC_EMAILS` list | Curated digest only — no sidebar, no commands |
| Delivery lead | `LEAD_EMAILS` list | Everything — full read/write/AI |
| Team member | Any `ALLOWED_DOMAINS` email not in above lists | Their project only |
| Diageo partner | `DIAGEO_EMAILS` list | Shared pages only — read only |
| Denied | Not on allowed domain | Login screen, access denied message |

---

## Adding new users

No admin panel needed. Just add their email to the right environment variable on Railway and redeploy (takes 30 seconds).

---

## The wiki on GitHub

Every write from ProjectX creates a git commit on your `projectx-wiki` repo:
- You can browse the full history on GitHub
- You can see who changed what and when
- You can roll back any page to any previous version via GitHub
- The `wiki/log.md` file is an append-only activity log
- The `wiki/index.md` is auto-maintained by the AI

---

## Local development

```bash
cd backend
cp .env.example .env
# Fill in your values
npm install
npm run dev
```

Then open http://localhost:3000

For local testing without SSO, temporarily add a dev bypass in server.js:
```javascript
// DEV ONLY — remove in production
app.get('/dev-login', (req, res) => {
  req.login({ id: '1', name: 'Dev User', email: 'dev@accenture.com', role: 'lead' }, () => {
    res.redirect('/');
  });
});
```

---

## Cost estimate

| Service | Cost |
|---------|------|
| Railway (Hobby plan) | $5/month or free on trial |
| GitHub private repo | Free |
| Anthropic API | ~$0.10–0.50 per day depending on usage |
| Microsoft Azure app registration | Free |

**Total: ~$5–10/month** once out of Railway free tier.
