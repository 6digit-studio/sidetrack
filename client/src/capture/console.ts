/**
 * Console capture - patches all console methods
 */

import type { Transport, CaptureModule } from '../types';

// All console methods we want to capture
const CONSOLE_METHODS = [
  'log', 'warn', 'error', 'debug', 'info', 'trace',
  'table', 'dir', 'dirxml', 'group', 'groupCollapsed',
  'groupEnd', 'count', 'countReset', 'time', 'timeEnd',
  'timeLog', 'assert', 'clear', 'profile', 'profileEnd'
] as const;

type ConsoleMethod = typeof CONSOLE_METHODS[number];

// Store original methods for restoration
const originals: Partial<Record<ConsoleMethod, Function>> = {};

/**
 * Serialize console arguments for transport
 * Handles circular references, functions, symbols, errors, etc.
 */
function serializeArgs(args: unknown[]): unknown[] {
  const seen = new WeakSet();

  function serialize(value: unknown, depth = 0): unknown {
    // Prevent infinite recursion
    if (depth > 10) return '[max depth]';

    if (value === undefined) return '[undefined]';
    if (value === null) return null;

    if (typeof value === 'function') {
      return `[Function: ${value.name || 'anonymous'}]`;
    }

    if (typeof value === 'symbol') {
      return value.toString();
    }

    if (typeof value === 'bigint') {
      return `${value.toString()}n`;
    }

    if (value instanceof Error) {
      return {
        __error: true,
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (value instanceof Date) {
      return { __date: true, iso: value.toISOString() };
    }

    if (value instanceof RegExp) {
      return { __regexp: true, source: value.source, flags: value.flags };
    }

    if (typeof value === 'object') {
      // Check for circular reference
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);

      if (Array.isArray(value)) {
        return value.map(v => serialize(v, depth + 1));
      }

      // Handle DOM elements
      if (typeof Element !== 'undefined' && value instanceof Element) {
        return `[Element: ${value.tagName.toLowerCase()}${value.id ? '#' + value.id : ''}${value.className ? '.' + value.className.split(' ').join('.') : ''}]`;
      }

      // Handle other objects
      try {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as object)) {
          result[key] = serialize((value as Record<string, unknown>)[key], depth + 1);
        }
        return result;
      } catch {
        return String(value);
      }
    }

    return value;
  }

  return args.map(arg => serialize(arg));
}

/**
 * Get a stack trace for the console call
 */
function getStack(): string | undefined {
  const err = new Error();
  if (!err.stack) return undefined;

  // Remove the first few lines (Error, getStack, wrapper function)
  const lines = err.stack.split('\n');
  return lines.slice(4).join('\n');
}

export function captureConsole(transport: Transport): CaptureModule {
  // Patch each console method
  for (const method of CONSOLE_METHODS) {
    if (typeof console[method] !== 'function') continue;

    originals[method] = console[method].bind(console);

    (console as any)[method] = function (...args: unknown[]) {
      // Call original first
      originals[method]!(...args);

      // Send to transport
      transport.send({
        _type: `console.${method}`,
        args: serializeArgs(args),
        stack: method === 'error' || method === 'warn' || method === 'trace' ? getStack() : undefined,
      });
    };
  }

  return {
    destroy() {
      // Restore original methods
      for (const method of CONSOLE_METHODS) {
        if (originals[method]) {
          (console as any)[method] = originals[method];
          delete originals[method];
        }
      }
    },
  };
}
