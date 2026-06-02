// access.js — Role resolution and permission checking
// Every permission decision in the app flows through this file.

const ROLES = {
  EXEC: 'exec',           // Piyush, Josh, Patrick — read-only curated digest
  LEAD: 'lead',           // Delivery leads — full read/write/AI
  TEAM: 'team',           // Team members — own project only
  DIAGEO: 'diageo',       // Diageo partners — shared pages only
  DENIED: 'denied',       // Not authorised
};

// Resolve a user's role from their email address
function resolveRole(email) {
  if (!email) return ROLES.DENIED;
  const lower = email.toLowerCase();

  const execEmails = (process.env.EXEC_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
  const leadEmails = (process.env.LEAD_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
  const diageoEmails = (process.env.DIAGEO_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
  const allowedDomains = (process.env.ALLOWED_DOMAINS || 'accenture.com').toLowerCase().split(',').map(d => d.trim()).filter(Boolean);

  if (execEmails.includes(lower)) return ROLES.EXEC;
  if (leadEmails.includes(lower)) return ROLES.LEAD;
  if (diageoEmails.includes(lower)) return ROLES.DIAGEO;

  // Domain-based fallback — team member if on an allowed domain
  const domain = lower.split('@')[1];
  if (domain && allowedDomains.includes(domain)) return ROLES.TEAM;

  return ROLES.DENIED;
}

// Which wiki pages a role can READ
function readablePages(role, userEmail) {
  switch (role) {
    case ROLES.EXEC:
      // Executives see only the curated digest pages
      return ['exec-digest', 'decision-log', 'risk-register'];

    case ROLES.LEAD:
      // Leads see everything
      return '*';

    case ROLES.TEAM:
      // Team members see their own project + shared pages
      return projectPagesForEmail(userEmail).concat(['seven-tests', 'stakeholders', 'decision-log']);

    case ROLES.DIAGEO:
      // Diageo partners see explicitly shared pages
      return ['mia-overview', 'exec-digest', 'stakeholders'];

    default:
      return [];
  }
}

// Which wiki pages a role can WRITE
function writablePages(role, userEmail) {
  switch (role) {
    case ROLES.EXEC:
    case ROLES.DIAGEO:
      return []; // Read-only

    case ROLES.LEAD:
      return '*'; // Can write anything

    case ROLES.TEAM:
      return projectPagesForEmail(userEmail); // Own project only

    default:
      return [];
  }
}

// Whether a role can use AI commands
function canUseAI(role) {
  return [ROLES.LEAD, ROLES.TEAM].includes(role);
}

// Whether a role can ingest new sources
function canIngest(role) {
  return [ROLES.LEAD, ROLES.TEAM].includes(role);
}

// Whether a role can run wiki lint
function canLint(role) {
  return role === ROLES.LEAD;
}

// Whether a role can manage other users
function canManageUsers(role) {
  return role === ROLES.LEAD;
}

// Map email to project pages (simple heuristic — extend as needed)
function projectPagesForEmail(email) {
  if (!email) return [];
  const lower = email.toLowerCase();

  const projectMap = {
    'tanisha': ['mia-overview', 'mia-risks', 'mia-decisions', 'mia-blockers'],
    'saket': ['mia-overview', 'mia-risks', 'mia-decisions', 'mia-blockers', 'mia-architecture'],
    'mahima': ['mia-overview', 'mia-ux'],
    'isha': ['mia-overview', 'mia-data'],
    'deeksha': ['meridian-overview', 'meridian-decisions'],
    'pankaj': ['meridian-overview', 'meridian-decisions'],
    'shefali': ['symphony-overview', 'symphony-decisions'],
    'aanchal': ['tequila-overview', 'tequila-risks', 'tequila-decisions', 'tequila-dashboards'],
    'avishek': ['mia-overview', 'meridian-overview', 'symphony-overview', 'tequila-overview'],
  };

  for (const [name, pages] of Object.entries(projectMap)) {
    if (lower.includes(name)) return pages;
  }

  return ['general'];
}

// Check if a specific page is accessible to a role
function canReadPage(role, userEmail, pageKey) {
  const readable = readablePages(role, userEmail);
  if (readable === '*') return true;
  return readable.includes(pageKey);
}

function canWritePage(role, userEmail, pageKey) {
  const writable = writablePages(role, userEmail);
  if (writable === '*') return true;
  return writable.includes(pageKey);
}

// Build the UI config object sent to the frontend
function uiConfig(role, userEmail, userName) {
  return {
    role,
    userName,
    userEmail,
    canIngest: canIngest(role),
    canUseAI: canUseAI(role),
    canLint: canLint(role),
    canManageUsers: canManageUsers(role),
    showSidebar: role !== ROLES.EXEC,
    showPortfolio: [ROLES.LEAD, ROLES.EXEC].includes(role),
    showAllProjects: role === ROLES.LEAD,
    isReadOnly: [ROLES.EXEC, ROLES.DIAGEO].includes(role),
    readablePages: readablePages(role, userEmail),
    writablePages: writablePages(role, userEmail),
  };
}

module.exports = {
  ROLES,
  resolveRole,
  readablePages,
  writablePages,
  canReadPage,
  canWritePage,
  canUseAI,
  canIngest,
  canLint,
  canManageUsers,
  uiConfig,
  projectPagesForEmail,
};
