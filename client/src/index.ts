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

import type { Config, CaptureModule } from './types';
import { DEFAULT_CONFIG } from './types';
import { detectRuntime, getCapabilities } from './runtime';
import { createTransport } from './transport';
import { captureConsole } from './capture/console';
import { captureErrors } from './capture/errors';
import { captureNetwork } from './capture/network';
import { captureAsync } from './capture/async';
import { captureDom } from './capture/dom';

export type { Config, Runtime, Capabilities } from './types';
export { detectRuntime, getCapabilities } from './runtime';

export interface SidetrackInstance {
  /** Manually flush buffered events to the server */
  flush(): Promise<void>;
  /** Stop all capture and clean up */
  destroy(): void;
  /** Current runtime */
  runtime: ReturnType<typeof detectRuntime>;
  /** Available capabilities */
  capabilities: ReturnType<typeof getCapabilities>;
}

/**
 * Initialize sidetrack observability capture
 * 
 * @param userConfig - Optional configuration overrides
 * @returns SidetrackInstance with flush() and destroy() methods
 */
export function init(userConfig: Partial<Config> = {}): SidetrackInstance {
  // Merge config with defaults
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    capture: {
      ...DEFAULT_CONFIG.capture,
      ...userConfig.capture,
    },
    network: {
      ...DEFAULT_CONFIG.network,
      ...userConfig.network,
    },
    tags: {
      ...DEFAULT_CONFIG.tags,
      ...userConfig.tags,
    },
  };
  
  const runtime = detectRuntime();
  const caps = getCapabilities();
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
  
  // Log init (will be captured by console capture if enabled)
  console.debug(`[sidetrack] Initialized (${runtime}, ${modules.length} capture modules)`);
  
  return {
    runtime,
    capabilities: caps,
    
    async flush() {
      await transport.flush();
    },
    
    destroy() {
      // Destroy all capture modules
      for (const mod of modules) {
        mod.destroy();
      }
      modules.length = 0;
      
      // Destroy transport (final flush)
      transport.destroy();
      
      console.debug('[sidetrack] Destroyed');
    },
  };
}

// Default export for convenience
export default { init };
