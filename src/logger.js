// logger.js — handles all SQLite database writes for the audit log
//
// Uses Node.js 22's built-in sqlite module (node:sqlite) — no install needed.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

// Figure out the absolute path to this file so we can find data/ relative to it
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '../data');
const DB_PATH    = join(DATA_DIR, 'audit.db');

// Create the data/ folder if it doesn't exist yet
mkdirSync(DATA_DIR, { recursive: true });

// Open the SQLite database (creates audit.db automatically if missing)
const db = new DatabaseSync(DB_PATH);

// Create the actions table if it doesn't already exist.
// Each row represents one tool call that passed through AgentAudit.
db.exec(`
  CREATE TABLE IF NOT EXISTS actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    timestamp   TEXT    NOT NULL,
    tool_name   TEXT    NOT NULL,
    parameters  TEXT    NOT NULL,
    result      TEXT,
    risk_level  TEXT    DEFAULT 'unknown'
  )
`);

// Create the violations table — one row per policy hit (block or alert).
db.exec(`
  CREATE TABLE IF NOT EXISTS violations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    timestamp   TEXT    NOT NULL,
    policy_name TEXT    NOT NULL,
    tool_name   TEXT    NOT NULL,
    parameters  TEXT    NOT NULL,
    action_taken TEXT   NOT NULL
  )
`);

// Prepare INSERT statements once — reusing prepared statements is faster
// than building and parsing new SQL strings on every call.
const insertStmt = db.prepare(`
  INSERT INTO actions (session_id, timestamp, tool_name, parameters, result, risk_level)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertViolationStmt = db.prepare(`
  INSERT INTO violations (session_id, timestamp, policy_name, tool_name, parameters, action_taken)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/**
 * Write one tool-call record to the database.
 *
 * @param {object} data
 * @param {string} data.session_id  - UUID for the current CLI session
 * @param {string} data.timestamp   - ISO 8601 timestamp of the call
 * @param {string} data.tool_name   - Name of the tool (e.g. "bash")
 * @param {object} data.parameters  - The arguments passed to the tool
 * @param {object} data.result      - The result returned by the tool
 * @param {string} data.risk_level  - Risk classification (currently always "unknown")
 */
export function logAction(data) {
  insertStmt.run(
    data.session_id,
    data.timestamp,
    data.tool_name,
    JSON.stringify(data.parameters),
    data.result != null ? JSON.stringify(data.result) : null,
    data.risk_level ?? 'unknown',
  );
}

/**
 * Write one policy violation to the violations table.
 *
 * @param {object} data
 * @param {string} data.session_id   - UUID for the current CLI session
 * @param {string} data.timestamp    - ISO 8601 timestamp
 * @param {string} data.policy_name  - Name of the triggered policy
 * @param {string} data.tool_name    - Name of the tool that triggered it
 * @param {object} data.parameters   - The arguments passed to the tool
 * @param {string} data.action_taken - "blocked" or "alerted"
 */
export function logViolation(data) {
  insertViolationStmt.run(
    data.session_id,
    data.timestamp,
    data.policy_name,
    data.tool_name,
    JSON.stringify(data.parameters),
    data.action_taken,
  );
}

export default db;
