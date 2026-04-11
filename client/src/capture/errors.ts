/**
 * Error capture - uncaught exceptions and unhandled promise rejections
 */

import type { Transport, CaptureModule } from '../types';
import { detectRuntime } from '../runtime';

export function captureErrors(transport: Transport): CaptureModule {
  const runtime = detectRuntime();
  const cleanupFns: Array<() => void> = [];

  if (runtime === 'browser' || runtime === 'worker') {
    // Browser: window.onerror and error event
    const errorHandler = (event: ErrorEvent) => {
      transport.send({
        _type: 'error.uncaught',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      });
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      transport.send({
        _type: 'error.unhandledrejection',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('error', errorHandler);
      window.addEventListener('unhandledrejection', rejectionHandler);

      cleanupFns.push(() => {
        window.removeEventListener('error', errorHandler);
        window.removeEventListener('unhandledrejection', rejectionHandler);
      });
    } else if (typeof self !== 'undefined') {
      // Web Worker
      self.addEventListener('error', errorHandler as EventListener);
      self.addEventListener('unhandledrejection', rejectionHandler as EventListener);

      cleanupFns.push(() => {
        self.removeEventListener('error', errorHandler as EventListener);
        self.removeEventListener('unhandledrejection', rejectionHandler as EventListener);
      });
    }
  }

  if (runtime === 'node' || runtime === 'bun') {
    // Node/Bun: process events
    if (typeof process !== 'undefined') {
      const uncaughtHandler = (err: Error) => {
        transport.send({
          _type: 'error.uncaught',
          message: err.message,
          stack: err.stack,
        });
      };

      const rejectionHandler = (reason: unknown) => {
        transport.send({
          _type: 'error.unhandledrejection',
          message: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        });
      };

      process.on('uncaughtException', uncaughtHandler);
      process.on('unhandledRejection', rejectionHandler);

      cleanupFns.push(() => {
        process.off('uncaughtException', uncaughtHandler);
        process.off('unhandledRejection', rejectionHandler);
      });
    }
  }

  if (runtime === 'deno') {
    // Deno: similar to browser but with Deno global
    const errorHandler = (event: ErrorEvent) => {
      transport.send({
        _type: 'error.uncaught',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      });
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      transport.send({
        _type: 'error.unhandledrejection',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };

    if (typeof globalThis !== 'undefined') {
      globalThis.addEventListener('error', errorHandler);
      globalThis.addEventListener('unhandledrejection', rejectionHandler);

      cleanupFns.push(() => {
        globalThis.removeEventListener('error', errorHandler);
        globalThis.removeEventListener('unhandledrejection', rejectionHandler);
      });
    }
  }

  return {
    destroy() {
      for (const fn of cleanupFns) {
        fn();
      }
    },
  };
}
