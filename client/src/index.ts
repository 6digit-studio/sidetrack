/**
 * sidetrack-client
 * 
 * Development observability firehose - captures everything, queries smartly.
 * 
 * Usage:
 *   import { init } from 'sidetrack-client'
 *   const sidetrack = init()
 *   
 *   // Or with config:
 *   const sidetrack = init({ endpoint: 'http://localhost:6274/events' })
 *   
 *   // Clean up when done:
 *   sidetrack.destroy()
 */

import type { Config, CaptureModule, FeedbackConfig, CommandHandler } from './types';
import { DEFAULT_CONFIG, DEFAULT_FEEDBACK_CONFIG } from './types';
import { detectRuntime, getCapabilities } from './runtime';
import { createTransport } from './transport';
import { captureConsole } from './capture/console';
import { captureErrors } from './capture/errors';
import { captureNetwork } from './capture/network';
import { captureAsync } from './capture/async';
import { captureDom } from './capture/dom';
import { captureFeedback, addRecentEvent } from './capture/feedback';
import { captureCommands, registerCommand, unregisterCommand, listCommands, getCommand } from './capture/commands';
import { discoverConfig, ensureServer, getEndpoint } from './config';

export type { Config, Runtime, Capabilities, FeedbackConfig, CheckpointEvent, CommandHandler, PendingCommand } from './types';
export { detectRuntime, getCapabilities } from './runtime';
export { discoverConfig, ensureServer, getEndpoint } from './config';
export { registerCommand, unregisterCommand, listCommands, getCommand } from './capture/commands';

// Track current instance for idempotent init
let currentInstance: SidetrackInstance | null = null;

export interface SidetrackInstance {
  /** Manually flush buffered events to the server */
  flush(): Promise<void>;
  /** Stop all capture and clean up */
  destroy(): void;
  /** Current runtime */
  runtime: ReturnType<typeof detectRuntime>;
  /** Available capabilities */
  capabilities: ReturnType<typeof getCapabilities>;
  /** Emit a checkpoint event for timing/correlation */
  checkpoint(id: string, name: string, payload?: Record<string, unknown>): void;
  /** Register a command handler */
  register(name: string, handler: CommandHandler | ((...args: unknown[]) => unknown | Promise<unknown>)): void;
  /** Unregister a command handler */
  unregister(name: string): boolean;
  /** List registered commands */
  commands(): Array<{ name: string; description?: string }>;
}

export interface InitOptions extends Partial<Config> {
  /**
   * Auto-spawn the sidetrack server if not running.
   * Only works in Node/Bun runtimes.
   * Default: true
   */
  autoSpawn?: boolean;
  
  /**
   * Enable command polling to allow remote command execution.
   * When enabled, the client polls for pending commands from the server.
   * Default: true
   */
  commands?: boolean;
  
  /**
   * Polling interval for commands in milliseconds.
   * Default: 1000 (1 second)
   */
  commandPollInterval?: number;
}

/**
 * Initialize sidetrack observability capture
 * 
 * Idempotent: if already initialized, the existing instance is destroyed
 * and a new one is created. This handles hot reload gracefully.
 * 
 * In server-side runtimes (Node/Bun), this will:
 * 1. Look for .sidetrack/config.json by walking up from cwd
 * 2. Use the port from config (or default 6274)
 * 3. Auto-spawn the server if not running (unless autoSpawn: false)
 * 
 * @param userConfig - Optional configuration overrides
 * @returns SidetrackInstance with flush() and destroy() methods
 */
export function init(userConfig: InitOptions = {}): SidetrackInstance {
  // Clean up existing instance (handles hot reload)
  if (currentInstance) {
    currentInstance.destroy();
    currentInstance = null;
  }
  
  const { autoSpawn = true, commands: enableCommands = true, commandPollInterval = 1000, ...configOverrides } = userConfig;
  
  // Discover endpoint from .sidetrack/config.json if not explicitly set
  const endpoint = configOverrides.endpoint ?? getEndpoint();
  
  // Merge config with defaults
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...configOverrides,
    endpoint,
    capture: {
      ...DEFAULT_CONFIG.capture,
      ...configOverrides.capture,
    },
    network: {
      ...DEFAULT_CONFIG.network,
      ...configOverrides.network,
    },
    tags: {
      ...DEFAULT_CONFIG.tags,
      ...configOverrides.tags,
    },
    feedback: configOverrides.feedback ?? DEFAULT_CONFIG.feedback,
  };
  
  const runtime = detectRuntime();
  const caps = getCapabilities();
  
  // Try to ensure server is running (async, fire-and-forget)
  if (autoSpawn && (runtime === 'node' || runtime === 'bun')) {
    // Fire and forget - don't block init
    ensureServer(true).catch(() => {
      // Ignore errors - server might already be running or will start later
    });
  }
  
  // Resolve feedback config
  let feedbackConfig: FeedbackConfig;
  if (typeof config.feedback === 'boolean') {
    feedbackConfig = { ...DEFAULT_FEEDBACK_CONFIG, enabled: config.feedback };
  } else {
    feedbackConfig = { ...DEFAULT_FEEDBACK_CONFIG, ...config.feedback };
  }
  const transport = createTransport(config);
  const modules: CaptureModule[] = [];
  
  // Initialize capture modules based on config and capabilities
  if (config.capture.console) {
    modules.push(captureConsole(transport));
  }
  
  if (config.capture.errors) {
    modules.push(captureErrors(transport));
  }
  
  if (config.capture.network) {
    modules.push(captureNetwork(transport, config));
  }
  
  if (config.capture.async && caps.asyncHooks) {
    modules.push(captureAsync(transport));
  }
  
  if (config.capture.dom && caps.dom) {
    modules.push(captureDom(transport));
  }
  
  // Feedback widget (browser only)
  if (caps.dom && feedbackConfig.enabled) {
    modules.push(captureFeedback(config, feedbackConfig));
  }
  
  // Command polling for remote execution
  if (enableCommands) {
    modules.push(captureCommands(transport, config.endpoint, commandPollInterval));
  }
  
  // Hook transport to feed recent events to feedback context
  const originalSend = transport.send.bind(transport);
  transport.send = (event) => {
    addRecentEvent(event);
    originalSend(event);
  };
  
  // Log init (will be captured by console capture if enabled)
  console.debug(`[sidetrack] Initialized (${runtime}, ${modules.length} capture modules)`);
  
  const instance: SidetrackInstance = {
    runtime,
    capabilities: caps,
    
    async flush() {
      await transport.flush();
    },
    
    checkpoint(id: string, name: string, payload?: Record<string, unknown>) {
      transport.send({
        _type: 'checkpoint',
        id,
        name,
        ...payload,
      });
    },
    
    register(name: string, handler: CommandHandler | ((...args: unknown[]) => unknown | Promise<unknown>)) {
      registerCommand(name, handler);
    },
    
    unregister(name: string): boolean {
      return unregisterCommand(name);
    },
    
    commands() {
      return listCommands();
    },
    
    destroy() {
      // Destroy all capture modules
      for (const mod of modules) {
        mod.destroy();
      }
      modules.length = 0;
      
      // Destroy transport (final flush)
      transport.destroy();
      
      // Clear current instance reference
      if (currentInstance === instance) {
        currentInstance = null;
      }
      
      console.debug('[sidetrack] Destroyed');
    },
  };
  
  currentInstance = instance;
  return instance;
}

// Default export for convenience
export default { init, registerCommand, unregisterCommand, listCommands };
