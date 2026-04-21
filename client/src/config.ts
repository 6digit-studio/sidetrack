/**
 * Config discovery and server auto-spawn for server-side runtimes
 * 
 * Walks up the directory tree to find .sidetrack/config.json,
 * reads the port, and optionally spawns the server if not running.
 */

import { detectRuntime } from './runtime';

const DEFAULT_PORT = 6274;

export interface SidetrackProjectConfig {
  port: number;
}

export interface DiscoveredConfig {
  configPath: string;
  projectRoot: string;
  config: SidetrackProjectConfig;
  endpoint: string;
}

/**
 * Find .sidetrack/config.json by walking up from cwd
 * Only works in Node/Bun/Deno runtimes
 */
export function discoverConfig(): DiscoveredConfig | null {
  const runtime = detectRuntime();
  
  // Only works in server-side runtimes
  if (runtime !== 'node' && runtime !== 'bun' && runtime !== 'deno') {
    return null;
  }
  
  try {
    // Dynamic imports to avoid bundling issues in browser
    const fs = require('fs');
    const path = require('path');
    
    let dir = process.cwd();
    
    while (dir !== '/') {
      const configPath = path.join(dir, '.sidetrack', 'config.json');
      
      if (fs.existsSync(configPath)) {
        try {
          const configContent = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(configContent) as SidetrackProjectConfig;
          
          return {
            configPath,
            projectRoot: dir,
            config,
            endpoint: `http://localhost:${config.port}/events`,
          };
        } catch {
          // Invalid config, keep looking
        }
      }
      
      dir = path.dirname(dir);
    }
    
    return null;
  } catch {
    // fs/path not available
    return null;
  }
}

/**
 * Check if sidetrack server is running on the given port
 */
export async function isServerRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    
    if (!response.ok) return false;
    
    const data = await response.json();
    return data.name === '6digit-sidetrack';
  } catch {
    return false;
  }
}

/**
 * Spawn the sidetrack server in the background
 * Only works in Node/Bun runtimes
 */
export function spawnServer(projectRoot: string): boolean {
  const runtime = detectRuntime();
  
  if (runtime !== 'node' && runtime !== 'bun') {
    return false;
  }
  
  try {
    const { spawn } = require('child_process');
    
    // Spawn sidetrack server detached
    const child = spawn('sidetrack', ['server'], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
    });
    
    // Unref so parent can exit
    child.unref();
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for server to be ready (with timeout)
 */
export async function waitForServer(port: number, timeoutMs: number = 5000): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    if (await isServerRunning(port)) {
      return true;
    }
    
    // Wait 100ms before retrying
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return false;
}

/**
 * Ensure sidetrack server is running, spawning if necessary
 * Returns the endpoint URL or null if unable to start
 */
export async function ensureServer(autoSpawn: boolean = true): Promise<string | null> {
  const discovered = discoverConfig();
  
  if (!discovered) {
    // No config found, use default port
    const running = await isServerRunning(DEFAULT_PORT);
    if (running) {
      return `http://localhost:${DEFAULT_PORT}/events`;
    }
    // No config and no server - can't auto-spawn without knowing where
    return null;
  }
  
  const { config, projectRoot, endpoint } = discovered;
  
  // Check if already running
  if (await isServerRunning(config.port)) {
    return endpoint;
  }
  
  // Try to spawn if requested
  if (autoSpawn) {
    const spawned = spawnServer(projectRoot);
    
    if (spawned) {
      // Wait for it to be ready
      const ready = await waitForServer(config.port, 5000);
      if (ready) {
        return endpoint;
      }
    }
  }
  
  // Return endpoint anyway - maybe server will start later
  return endpoint;
}

/**
 * Get the endpoint URL from config or default
 * Synchronous version for cases where we don't want to wait
 */
export function getEndpoint(): string {
  const discovered = discoverConfig();
  
  if (discovered) {
    return discovered.endpoint;
  }
  
  return `http://localhost:${DEFAULT_PORT}/events`;
}
