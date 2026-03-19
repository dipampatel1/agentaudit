#!/usr/bin/env node

// index.js — CLI entry point
// Run:  agentaudit start
// This generates a session ID, prints a banner, then starts the MCP server.
// Claude Code connects to this process over stdio and can call the logged tools.

import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { startMCPServer } from './interceptor.js';
import { startDashboard }  from './server.js';

const program = new Command();

program
  .name('agentaudit')
  .description('Trust and observability layer for Claude Code agent sessions')
  .version('0.1.0');

program
  .command('start')
  .description('Start AgentAudit as an MCP server and begin logging tool calls')
  .action(async () => {
    // Generate a unique ID for this session so every log row is traceable
    const sessionId = uuidv4();

    // All output goes to stderr to keep stdout clean for the MCP JSON-RPC protocol
    process.stderr.write(`\nAgentAudit v0.1 — Session ${sessionId} started\n`);
    process.stderr.write(`Logging all tool calls to data/audit.db\n`);
    process.stderr.write(`Waiting for Claude Code to connect...\n\n`);

    // Start the MCP server — this call blocks until the connection closes
    await startMCPServer(sessionId);
  });

program
  .command('dashboard')
  .description('Start a local web dashboard to visualize audit logs and policy violations')
  .action(() => {
    startDashboard();
  });

program.parse();
