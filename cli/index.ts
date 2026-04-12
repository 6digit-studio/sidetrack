#!/usr/bin/env bun
/**
 * Sidetrack CLI
 * 
 * Commands:
 *   sidetrack server         Start the sidetrack server
 *   sidetrack install skill  Install Claude skill to ~/.claude/skills/
 *   sidetrack recent         Query recent events
 *   sidetrack search <term>  Search events
 *   sidetrack feedback       List open feedback
 *   sidetrack resolve <id>   Mark feedback as resolved
 *   sidetrack help           Show help
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const SIDETRACK_URL = process.env.SIDETRACK_URL || 'http://localhost:6274';

// Find the package root (where package.json is)
function findPackageRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return dirname(new URL(import.meta.url).pathname);
}

const PACKAGE_ROOT = findPackageRoot();

async function startServer() {
  const serverPath = join(PACKAGE_ROOT, 'server', 'index.ts');
  
  if (!existsSync(serverPath)) {
    console.error(`Server not found at ${serverPath}`);
    process.exit(1);
  }
  
  console.log('Starting sidetrack server...');
  
  const child = spawn('bun', ['run', serverPath], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
  });
  
  child.on('error', (err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
  
  // Keep running until interrupted
  process.on('SIGINT', () => {
    child.kill('SIGINT');
    process.exit(0);
  });
}

async function installSkill() {
  const skillSource = join(PACKAGE_ROOT, 'skills', 'sidetrack.md');
  const skillsDir = join(homedir(), '.claude', 'skills');
  const skillDest = join(skillsDir, 'sidetrack.md');
  
  if (!existsSync(skillSource)) {
    console.error(`Skill file not found at ${skillSource}`);
    process.exit(1);
  }
  
  // Create skills directory if needed
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
    console.log(`Created ${skillsDir}`);
  }
  
  // Copy skill file
  copyFileSync(skillSource, skillDest);
  console.log(`Installed sidetrack skill to ${skillDest}`);
  console.log('\nYou can now use /sidetrack in any Claude Code session.');
}

async function queryRecent(limit = 20, filter?: string) {
  try {
    let url = `${SIDETRACK_URL}/recent?limit=${limit}`;
    if (filter) {
      url += `&${filter}`;
    }
    
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    
    const events = await res.json();
    
    if (events.length === 0) {
      console.log('No events found.');
      return;
    }
    
    for (const event of events) {
      const time = new Date(event._ts || event._received_at).toLocaleTimeString();
      const type = event._type || event.type || 'unknown';
      
      let summary = '';
      if (event.args) {
        summary = event.args.map((a: unknown) => 
          typeof a === 'string' ? a : JSON.stringify(a)
        ).join(' ').slice(0, 100);
      } else if (event.message) {
        summary = event.message.slice(0, 100);
      } else if (event.url) {
        summary = event.url;
      }
      
      console.log(`[${time}] ${type}: ${summary}`);
    }
  } catch (err) {
    console.error('Failed to query sidetrack. Is the server running?');
    console.error(`  ${err}`);
    process.exit(1);
  }
}

async function searchEvents(query: string, limit = 20) {
  try {
    const res = await fetch(`${SIDETRACK_URL}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    
    const events = await res.json();
    
    if (events.length === 0) {
      console.log(`No events matching "${query}".`);
      return;
    }
    
    console.log(`Found ${events.length} events:\n`);
    
    for (const event of events) {
      const time = new Date(event._ts || event._received_at).toLocaleTimeString();
      const type = event._type || event.type || 'unknown';
      console.log(`[${time}] ${type}`);
      
      if (event.args) {
        console.log(`  ${JSON.stringify(event.args).slice(0, 200)}`);
      }
      console.log();
    }
  } catch (err) {
    console.error('Failed to search sidetrack. Is the server running?');
    process.exit(1);
  }
}

async function listFeedback(status = 'open') {
  try {
    const res = await fetch(`${SIDETRACK_URL}/feedback?status=${status}`);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    
    const feedback = await res.json();
    
    if (feedback.length === 0) {
      console.log(`No ${status} feedback.`);
      return;
    }
    
    console.log(`${status.toUpperCase()} FEEDBACK:\n`);
    
    for (const item of feedback) {
      const time = new Date(item.created_at).toLocaleString();
      console.log(`#${item.id} [${time}]`);
      console.log(`  ${item.message}`);
      if (item.url) {
        console.log(`  URL: ${item.url}`);
      }
      console.log();
    }
  } catch (err) {
    console.error('Failed to get feedback. Is the server running?');
    process.exit(1);
  }
}

async function resolveFeedback(id: number) {
  try {
    const res = await fetch(`${SIDETRACK_URL}/feedback/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    
    const result = await res.json();
    
    if (result.ok) {
      console.log(`Feedback #${id} marked as resolved.`);
    } else {
      console.error(`Failed to resolve feedback: ${result.error || 'unknown error'}`);
    }
  } catch (err) {
    console.error('Failed to update feedback. Is the server running?');
    process.exit(1);
  }
}

async function showStats() {
  try {
    const res = await fetch(`${SIDETRACK_URL}/stats`);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    
    const stats = await res.json();
    
    console.log('Sidetrack Stats:');
    console.log(`  Events: ${stats.count}`);
    if (stats.oldest_at && stats.newest_at) {
      const span = Math.round(stats.span_ms / 1000);
      console.log(`  Time span: ${span} seconds`);
    }
  } catch (err) {
    console.error('Failed to get stats. Is the server running?');
    process.exit(1);
  }
}

async function awaitEvent(pattern: string, cwd?: string, timeoutMs?: number): Promise<void> {
  let url = `${SIDETRACK_URL}/stream`;
  const params = new URLSearchParams();
  params.set('pattern', pattern);
  if (cwd) params.set('cwd', cwd);
  url += `?${params}`;
  
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  
  if (timeoutMs) {
    timeoutId = setTimeout(() => {
      controller.abort();
      console.error(`Timeout: no event matching /${pattern}/i after ${timeoutMs / 1000}s`);
      process.exit(1);
    }, timeoutMs);
  }
  
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          try {
            const event = JSON.parse(jsonStr);
            
            // Skip the connection message
            if (event.type === 'connected') {
              continue;
            }
            
            // Found a matching event! Print and exit successfully.
            if (timeoutId) clearTimeout(timeoutId);
            console.log(JSON.stringify(event));
            process.exit(0);
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // Timeout already handled
      return;
    }
    console.error('Failed to connect to stream. Is the server running?');
    console.error(`  ${err}`);
    process.exit(1);
  }
}

async function tailStream(pattern?: string, cwd?: string) {
  let url = `${SIDETRACK_URL}/stream`;
  const params = new URLSearchParams();
  if (pattern) params.set('pattern', pattern);
  if (cwd) params.set('cwd', cwd);
  if (params.toString()) url += `?${params}`;
  
  console.log(`Connecting to ${url}...`);
  console.log('Press Ctrl+C to stop.\n');
  
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          try {
            const event = JSON.parse(jsonStr);
            
            // Skip the connection message
            if (event.type === 'connected') {
              console.log(`Connected. Watching for events${pattern ? ` matching /${pattern}/i` : ''}${cwd ? ` in ${cwd}` : ''}...\n`);
              continue;
            }
            
            // Format and print the event
            const time = new Date(event._received_at || Date.now()).toLocaleTimeString();
            const type = event._type || event.type || event.brain || 'event';
            const cwdStr = event.cwd ? ` [${event.cwd.split('/').slice(-2).join('/')}]` : '';
            
            // Build a summary from common fields
            let summary = '';
            if (event.text) {
              summary = event.text.slice(0, 150);
            } else if (event.msg) {
              summary = event.msg.slice(0, 150);
            } else if (event.message) {
              summary = event.message.slice(0, 150);
            } else if (event.args) {
              summary = event.args.map((a: unknown) => 
                typeof a === 'string' ? a : JSON.stringify(a)
              ).join(' ').slice(0, 150);
            } else {
              // Fallback: show condensed JSON
              const { _received_at, _id, ...rest } = event;
              summary = JSON.stringify(rest).slice(0, 150);
            }
            
            console.log(`[${time}]${cwdStr} ${type}: ${summary}`);
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.log('\nStream closed.');
      return;
    }
    console.error('Failed to connect to stream. Is the server running?');
    console.error(`  ${err}`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Sidetrack - Development observability for AI-assisted coding

USAGE:
  sidetrack <command> [options]

COMMANDS:
  server              Start the sidetrack server
  install skill       Install Claude skill to ~/.claude/skills/
  
  tail [pattern]      Stream events in real-time (SSE)
  await <pattern>     Block until an event matches pattern
  recent [limit]      Show recent events (default: 20)
  search <term>       Search events
  stats               Show event statistics
  
  feedback [status]   List feedback (default: open)
  resolve <id>        Mark feedback as resolved
  wontfix <id>        Mark feedback as wontfix
  
  help                Show this help message

ENVIRONMENT:
  SIDETRACK_URL       Server URL (default: http://localhost:6274)

EXAMPLES:
  sidetrack server
  sidetrack install skill
  sidetrack tail                    # stream all events
  sidetrack tail "error|BLOCKED"    # stream events matching pattern
  sidetrack tail --cwd=/path/to/dir # stream events from specific directory
  sidetrack await "DONE"            # block until DONE appears
  sidetrack await "HANDOFF" --timeout=30  # timeout after 30 seconds
  sidetrack recent 50
  sidetrack search "error"
  sidetrack feedback
  sidetrack resolve 3
`);
}

// Parse arguments and run
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'server':
    startServer();
    break;
    
  case 'install':
    if (args[1] === 'skill') {
      installSkill();
    } else {
      console.error('Unknown install target. Did you mean: sidetrack install skill');
      process.exit(1);
    }
    break;
    
  case 'tail': {
    // Parse tail arguments: sidetrack tail [pattern] [--cwd=path]
    let pattern: string | undefined;
    let cwd: string | undefined;
    
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--cwd=')) {
        cwd = arg.slice(6);
      } else if (arg.startsWith('--pattern=')) {
        pattern = arg.slice(10);
      } else if (!arg.startsWith('--')) {
        pattern = arg;
      }
    }
    
    tailStream(pattern, cwd);
    break;
  }
  
  case 'await': {
    // Parse await arguments: sidetrack await <pattern> [--cwd=path] [--timeout=seconds]
    let pattern: string | undefined;
    let cwd: string | undefined;
    let timeoutMs: number | undefined;
    
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--cwd=')) {
        cwd = arg.slice(6);
      } else if (arg.startsWith('--timeout=')) {
        timeoutMs = parseInt(arg.slice(10)) * 1000; // Convert seconds to ms
      } else if (!arg.startsWith('--')) {
        pattern = arg;
      }
    }
    
    if (!pattern) {
      console.error('Usage: sidetrack await <pattern> [--timeout=seconds] [--cwd=path]');
      process.exit(1);
    }
    
    awaitEvent(pattern, cwd, timeoutMs);
    break;
  }
    
  case 'recent':
    queryRecent(parseInt(args[1]) || 20, args[2]);
    break;
    
  case 'search':
    if (!args[1]) {
      console.error('Usage: sidetrack search <term>');
      process.exit(1);
    }
    searchEvents(args[1], parseInt(args[2]) || 20);
    break;
    
  case 'stats':
    showStats();
    break;
    
  case 'feedback':
    listFeedback(args[1] || 'open');
    break;
    
  case 'resolve':
    if (!args[1]) {
      console.error('Usage: sidetrack resolve <id>');
      process.exit(1);
    }
    resolveFeedback(parseInt(args[1]));
    break;
    
  case 'wontfix':
    if (!args[1]) {
      console.error('Usage: sidetrack wontfix <id>');
      process.exit(1);
    }
    fetch(`${SIDETRACK_URL}/feedback/${args[1]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'wontfix' }),
    }).then(res => res.json()).then(result => {
      if (result.ok) {
        console.log(`Feedback #${args[1]} marked as wontfix.`);
      } else {
        console.error(`Failed: ${result.error || 'unknown error'}`);
      }
    });
    break;
    
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
    
  case undefined:
    showHelp();
    break;
    
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "sidetrack help" for usage.');
    process.exit(1);
}
