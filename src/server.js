// server.js — Express backend for the AgentAudit dashboard
//
// Reads directly from data/audit.db via better-sqlite3 (synchronous, no ORM).
// All endpoints return JSON. Opened by the "agentaudit dashboard" command.

import express        from 'express';
import Database       from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync }  from 'fs';
import open            from 'open';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DB_PATH    = join(__dirname, '../data/audit.db');
const HTML_PATH  = join(__dirname, 'dashboard/index.html');
const PORT       = 4321;

// ---------------------------------------------------------------------------
// Helper — open (or re-open) the DB on every request so the dashboard always
// sees the latest data written by a concurrently running agentaudit session.
// ---------------------------------------------------------------------------
function getDb() {
  if (!existsSync(DB_PATH)) {
    // Return a stub if no session has been run yet
    return null;
  }
  return new Database(DB_PATH, { readonly: true });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Serve the single-page dashboard at /
app.get('/', (_req, res) => {
  res.sendFile(HTML_PATH);
});

// GET /api/sessions — unique sessions with their start time and action count
app.get('/api/sessions', (_req, res) => {
  const db = getDb();
  if (!db) return res.json([]);

  const rows = db.prepare(`
    SELECT
      session_id,
      MIN(timestamp)  AS started_at,
      COUNT(*)        AS action_count
    FROM actions
    GROUP BY session_id
    ORDER BY started_at DESC
  `).all();

  db.close();
  res.json(rows);
});

// GET /api/actions — newest 100 actions
app.get('/api/actions', (_req, res) => {
  const db = getDb();
  if (!db) return res.json([]);

  const rows = db.prepare(`
    SELECT id, session_id, timestamp, tool_name, parameters, risk_level
    FROM actions
    ORDER BY id DESC
    LIMIT 100
  `).all();

  db.close();
  res.json(rows);
});

// GET /api/violations — all violations, newest first
app.get('/api/violations', (_req, res) => {
  const db = getDb();
  if (!db) return res.json([]);

  // Guard against the table not yet existing (pre-Phase 2 databases)
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='violations'
  `).get();

  if (!tableExists) { db.close(); return res.json([]); }

  const rows = db.prepare(`
    SELECT id, session_id, timestamp, policy_name, tool_name, parameters, action_taken
    FROM violations
    ORDER BY id DESC
  `).all();

  db.close();
  res.json(rows);
});

// GET /api/stats — aggregate counts
app.get('/api/stats', (_req, res) => {
  const db = getDb();
  if (!db) return res.json({ total_actions: 0, total_violations: 0, total_blocked: 0, total_alerted: 0 });

  const { total_actions } = db.prepare(`SELECT COUNT(*) AS total_actions FROM actions`).get();

  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='violations'
  `).get();

  let total_violations = 0, total_blocked = 0, total_alerted = 0;
  if (tableExists) {
    ({ total_violations } = db.prepare(`SELECT COUNT(*) AS total_violations FROM violations`).get());
    ({ total_blocked }    = db.prepare(`SELECT COUNT(*) AS total_blocked  FROM violations WHERE action_taken = 'blocked'`).get());
    ({ total_alerted }    = db.prepare(`SELECT COUNT(*) AS total_alerted  FROM violations WHERE action_taken = 'alerted'`).get());
  }

  db.close();
  res.json({ total_actions, total_violations, total_blocked, total_alerted });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
export function startDashboard() {
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    process.stderr.write(`\nAgentAudit Dashboard — listening on ${url}\n`);
    process.stderr.write(`Opening browser...\n\n`);
    open(url);
  });
}
