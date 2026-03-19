// policy.js — loads .agentaudit.yml and evaluates tool calls against policies
//
// Rules are plain-English strings. Matching uses keyword and pattern extraction:
//   • tool name filter  — if the rule mentions a known tool name, only that tool can trigger it
//   • "containing X"   — the parameter JSON must include keyword X
//   • "outside <path>" — violation when the file path is NOT under the allowed directory
//   • fallback          — any rule that passes all checks above is considered triggered

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = join(__dirname, '../.agentaudit.yml');

const KNOWN_TOOLS = ['bash', 'web_fetch', 'http_request', 'read_file', 'write_file'];

/**
 * Load and return the policies array from .agentaudit.yml.
 * Returns [] if the file is missing or has no policies.
 */
export function loadPolicies() {
  if (!existsSync(POLICY_FILE)) return [];
  const raw    = readFileSync(POLICY_FILE, 'utf-8');
  const config = yaml.load(raw);
  return config?.policies ?? [];
}

/**
 * Determine whether a single policy rule is triggered by this tool call.
 *
 * @param {string} rule        - Plain-English rule string from the policy file
 * @param {string} toolName    - Name of the tool being called
 * @param {object} params      - Parsed parameters object
 * @param {string} paramsJson  - JSON-stringified parameters (for keyword search)
 * @returns {boolean}
 */
function ruleMatches(rule, toolName, params, paramsJson) {
  const ruleLower   = rule.toLowerCase();
  const paramsLower = paramsJson.toLowerCase();

  // ── 1. Tool-name filter ─────────────────────────────────────────────────────
  // If the rule names specific tools, it only applies to those tools.
  const mentionedTools = KNOWN_TOOLS.filter(t => ruleLower.includes(t));
  if (mentionedTools.length > 0 && !mentionedTools.includes(toolName)) {
    return false;
  }

  // ── 2. "containing <keyword>" ───────────────────────────────────────────────
  // e.g. "never run any bash command containing rm"
  const containingMatch = ruleLower.match(/containing\s+(\S+)/);
  if (containingMatch) {
    const keyword = containingMatch[1].replace(/[^\w\-\/]/g, '');
    if (!paramsLower.includes(keyword)) return false;
  }

  // ── 3. "outside (the) <path> (directory|folder)" ───────────────────────────
  // e.g. "block any file write outside the /tmp directory"
  // Violation = path does NOT start with the allowed directory.
  const outsideMatch = ruleLower.match(/outside\s+(?:the\s+)?(\S+?)(?:\s+directory|\s+folder|\s*$)/);
  if (outsideMatch) {
    const allowedPath = outsideMatch[1];
    const filePath    = (params.path || params.file || '').replace(/\\/g, '/');
    // If this tool call has no path parameter the rule cannot apply to it
    if (!filePath) return false;
    // If the file is inside the allowed dir → no violation
    if (filePath.startsWith(allowedPath)) return false;
    // Outside the allowed dir → violation
    return true;
  }

  // ── 4. Fallback ─────────────────────────────────────────────────────────────
  // All checks passed (or none applied) → the rule is triggered.
  return true;
}

/**
 * Evaluate an intercepted action against all loaded policies.
 * Returns the first violation found, or { violated: false } if none.
 *
 * @param {{ tool_name: string, parameters: object }} action
 * @param {Array} policies  - Array of policy objects from loadPolicies()
 * @returns {{ violated: boolean, policy_name?: string, action_required?: string }}
 */
export function evaluateAction(action, policies) {
  const { tool_name, parameters } = action;
  const paramsJson = JSON.stringify(parameters);

  for (const policy of policies) {
    if (policy.tool && policy.tool !== tool_name) continue;
    if (ruleMatches(policy.rule, tool_name, parameters, paramsJson)) {
      return {
        violated:        true,
        policy_name:     policy.name,
        action_required: policy.action,  // "block" or "alert"
      };
    }
  }

  return { violated: false };
}
