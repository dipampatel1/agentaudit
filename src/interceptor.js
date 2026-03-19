// interceptor.js — creates the MCP server and handles every tool call
//
// Claude Code connects to this server over stdio (standard input/output).
// When Claude calls one of our tools, we:
//   1. Print the call to the terminal so you can see it in real time
//   2. Actually execute the requested operation
//   3. Write a record of the call + result to SQLite via logger.js

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { exec }                 from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { promisify }            from 'util';
import { logAction, logViolation } from './logger.js';
import { loadPolicies, evaluateAction } from './policy.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Tool definitions — these are what Claude Code sees when it asks
// "what tools does AgentAudit provide?"
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'bash',
    description: 'Run a shell command and return its output. Every invocation is logged.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file from disk. Every read is logged.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write (or overwrite) a file on disk. Every write is logged.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Path to write to' },
        content: { type: 'string', description: 'Content to write into the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return the response body (capped at 5 000 chars). Every fetch is logged.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to GET' },
      },
      required: ['url'],
    },
  },
];

// ---------------------------------------------------------------------------
// Execute a tool and return { result, isError }
// ---------------------------------------------------------------------------
async function executeTool(name, args) {
  if (name === 'bash') {
    // Run the command in a shell, with a 30-second safety timeout
    const { stdout, stderr } = await execAsync(args.command, { timeout: 30_000 });
    return { stdout, stderr };
  }

  if (name === 'read_file') {
    const content = readFileSync(args.path, 'utf-8');
    return { content };
  }

  if (name === 'write_file') {
    writeFileSync(args.path, args.content, 'utf-8');
    return { success: true };
  }

  if (name === 'web_fetch') {
    const response = await fetch(args.url);
    const body     = await response.text();
    // Trim the body so we don't blow up the database with huge HTML pages
    return { status: response.status, body: body.slice(0, 5_000) };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ANSI colour helpers — output goes to stderr so MCP stdio isn't polluted
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RESET  = '\x1b[0m';

// ---------------------------------------------------------------------------
// Start the MCP server
// ---------------------------------------------------------------------------
export async function startMCPServer(sessionId) {
  // Load policies once at startup; a static load is fine for Phase 2.
  const policies = loadPolicies();

  const server = new Server(
    { name: 'agentaudit', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // When Claude Code asks "what tools do you have?", return our list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // When Claude Code actually calls a tool, this handler runs
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const timestamp = new Date().toISOString();

    // Build a human-readable time string for the terminal (HH:MM:SS)
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    // ── Policy evaluation ──────────────────────────────────────────────────
    const verdict = evaluateAction({ tool_name: name, parameters: args }, policies);

    if (verdict.violated && verdict.action_required === 'block') {
      // Print in red and stop the tool from running
      process.stderr.write(
        `${RED}[BLOCKED] Policy: ${verdict.policy_name} — ${name} call rejected${RESET}\n`,
      );

      // Log the violation to the violations table
      logViolation({
        session_id:  sessionId,
        timestamp,
        policy_name: verdict.policy_name,
        tool_name:   name,
        parameters:  args,
        action_taken: 'blocked',
      });

      // Also record in actions table with risk_level "blocked"
      logAction({
        session_id: sessionId,
        timestamp,
        tool_name:  name,
        parameters: args,
        result:     { blocked: true, policy: verdict.policy_name },
        risk_level: 'blocked',
      });

      // Return an error response to Claude Code
      return {
        content: [{ type: 'text', text: `Blocked by policy: ${verdict.policy_name}` }],
        isError: true,
      };
    }

    if (verdict.violated && verdict.action_required === 'alert') {
      // Print in yellow, but let the call proceed
      process.stderr.write(
        `${YELLOW}[ALERT] Policy: ${verdict.policy_name} — ${name} called${RESET}\n`,
      );

      logViolation({
        session_id:  sessionId,
        timestamp,
        policy_name: verdict.policy_name,
        tool_name:   name,
        parameters:  args,
        action_taken: 'alerted',
      });
    } else {
      // No violation — print in green
      process.stderr.write(
        `${GREEN}[OK] TOOL: ${name}${RESET} | PARAMS: ${JSON.stringify(args)}\n`,
      );
    }

    // ── Execute the tool ───────────────────────────────────────────────────
    let result  = null;
    let isError = false;

    try {
      result = await executeTool(name, args);
    } catch (err) {
      result  = { error: err.message };
      isError = true;
    }

    // Determine risk_level for the actions table
    const riskLevel = verdict.violated ? verdict.action_required : 'ok';

    // Write the record to SQLite regardless of success or failure
    logAction({
      session_id: sessionId,
      timestamp,
      tool_name:  name,
      parameters: args,
      result,
      risk_level: riskLevel,
    });

    // Return the result in the format the MCP protocol expects
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError,
    };
  });

  // Connect to Claude Code using stdio transport
  // Claude Code will launch this process and talk to it via stdin/stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
