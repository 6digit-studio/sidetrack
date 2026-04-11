/**
 * Async hooks capture - tracks async resource lifecycle (Node/Bun)
 */

import type { Transport, CaptureModule } from '../types';
import { detectRuntime } from '../runtime';

export function captureAsync(transport: Transport): CaptureModule {
  const runtime = detectRuntime();
  
  // Only available in Node.js and partially in Bun
  if (runtime !== 'node' && runtime !== 'bun') {
    return { destroy() {} };
  }
  
  let asyncHooks: any;
  let hook: any;
  
  try {
    asyncHooks = require('async_hooks');
  } catch {
    // async_hooks not available
    return { destroy() {} };
  }
  
  // Track active async resources to avoid noise
  const activeResources = new Map<number, { type: string; triggerAsyncId: number }>();
  
  // Resource types we care about (filter out internal noise)
  const interestingTypes = new Set([
    'PROMISE',
    'TIMERWRAP',
    'TIMEOUT',
    'IMMEDIATE',
    'TCPWRAP',
    'TCPCONNECTWRAP',
    'TCPSERVERWRAP',
    'GETADDRINFOREQWRAP',
    'FSREQCALLBACK',
    'FILEHANDLE',
    'HTTPINCOMINGMESSAGE',
    'HTTPCLIENTREQUEST',
    'WRITEWRAP',
    'SHUTDOWNWRAP',
    'QUERYWRAP',
  ]);
  
  try {
    hook = asyncHooks.createHook({
      init(asyncId: number, type: string, triggerAsyncId: number) {
        if (!interestingTypes.has(type)) return;
        
        activeResources.set(asyncId, { type, triggerAsyncId });
        
        transport.send({
          _type: 'async.init',
          asyncId,
          triggerAsyncId,
          resourceType: type,
        });
      },
      
      before(asyncId: number) {
        const resource = activeResources.get(asyncId);
        if (!resource) return;
        
        transport.send({
          _type: 'async.before',
          asyncId,
          triggerAsyncId: resource.triggerAsyncId,
          resourceType: resource.type,
        });
      },
      
      after(asyncId: number) {
        const resource = activeResources.get(asyncId);
        if (!resource) return;
        
        transport.send({
          _type: 'async.after',
          asyncId,
          triggerAsyncId: resource.triggerAsyncId,
          resourceType: resource.type,
        });
      },
      
      destroy(asyncId: number) {
        const resource = activeResources.get(asyncId);
        if (!resource) return;
        
        transport.send({
          _type: 'async.destroy',
          asyncId,
          triggerAsyncId: resource.triggerAsyncId,
          resourceType: resource.type,
        });
        
        activeResources.delete(asyncId);
      },
      
      promiseResolve(asyncId: number) {
        const resource = activeResources.get(asyncId);
        if (!resource) return;
        
        transport.send({
          _type: 'async.promiseResolve',
          asyncId,
          triggerAsyncId: resource.triggerAsyncId,
          resourceType: resource.type,
        });
      },
    });
    
    hook.enable();
  } catch (err) {
    // Bun may have partial support or throw
    console.debug('[sidetrack] async_hooks not fully supported:', err);
    return { destroy() {} };
  }
  
  return {
    destroy() {
      if (hook) {
        hook.disable();
      }
      activeResources.clear();
    },
  };
}
