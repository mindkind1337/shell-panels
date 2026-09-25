// Set up the Tessel team tools (teamMcp/server.cjs) for the agent CLIs, so
// teammates message each other in the background (never typed into a
// terminal):
//   - the server script, copied to Tessel's data folder;
//   - Claude Code: an MCP server "tessel-team" (user scope) and hooks that
//     show new team messages as context (UserPromptSubmit, PostToolUse, Stop);
//   - Codex: the same MCP server in ~/.codex/config.toml, forwarding the
//     pane's TESSEL_* variables.
// Each step is skipped when already done; other settings are left as they are.
import fs from 'fs'
import os from 'os'
import { join } from 'path'

export const SERVER_NAME = 'tessel-team'
const HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop']

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tessel-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

// Write the server script where agents can run it. -> its path
export function writeServerScript(dataDir, source) {
  const file = join(dataDir, 'tessel-team-mcp.cjs')
  let old = null
  try {
    old = fs.readFileSync(file, 'utf8')
  } catch {
    // first time
  }
  if (old !== source) writeAtomic(file, source)
  return file
}

const quote = (p) => `"${p}"`

// Claude Code hooks in ~/.claude/settings.json. -> true when changed
export function installClaudeHooks(scriptPath, home = os.homedir()) {
  const dir = join(home, '.claude')
  const file = join(dir, 'settings.json')
  const exists = fs.existsSync(file)
  const settings = exists ? readJson(file) : {}
  // A settings file Tessel cannot read is never overwritten.
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
  const command = `node ${quote(scriptPath)} --hook`
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  let changed = false
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    // An older Tessel entry (another path) is replaced; others are kept.
    const others = list.filter(
      (g) => !(g && Array.isArray(g.hooks) && g.hooks.some((h) => String(h.command || '').includes('tessel-team-mcp.cjs')))
    )
    const ours = list.find(
      (g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command)
    )
    if (ours && others.length === list.length - 1) continue
    settings.hooks[event] = [...others, { matcher: '', hooks: [{ type: 'command', command }] }]
    changed = true
  }
  if (!changed) return false
  fs.mkdirSync(dir, { recursive: true })
  if (exists && !fs.existsSync(`${file}.before-tessel`)) fs.copyFileSync(file, `${file}.before-tessel`)
  writeAtomic(file, JSON.stringify(settings, null, 2) + '\n')
  return true
}

// Codex: [mcp_servers.tessel-team] in ~/.codex/config.toml. -> true when added
export function installCodexServer(scriptPath, home = os.homedir()) {
  const dir = join(home, '.codex')
  if (!fs.existsSync(dir)) return false // Codex not set up here
  const file = join(dir, 'config.toml')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (/^\[mcp_servers\.tessel-team\]/m.test(text)) return false
  // TOML literal strings ('...') keep Windows backslashes as they are.
  if (scriptPath.includes("'")) return false
  const table =
    `\n[mcp_servers.${SERVER_NAME}]\n` +
    `command = 'node'\n` +
    `args = ['${scriptPath}']\n` +
    `env_vars = ["TESSEL_PANE_ID", "TESSEL_PROJECT_DIR"]\n`
  if (text && !fs.existsSync(`${file}.before-tessel`)) fs.copyFileSync(file, `${file}.before-tessel`)
  writeAtomic(file, text.replace(/\s*$/, '\n') + table)
  return true
}

// Claude Code's MCP server (user scope), from ~/.claude.json. -> true when
// it is already there with this script.
export function claudeServerPresent(scriptPath, home = os.homedir()) {
  const cfg = readJson(join(home, '.claude.json'))
  const s = cfg && cfg.mcpServers && cfg.mcpServers[SERVER_NAME]
  return !!(s && Array.isArray(s.args) && s.args.includes(scriptPath))
}
