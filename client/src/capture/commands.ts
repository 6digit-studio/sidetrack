/**
 * Command capture module
 * 
 * Polls the sidetrack server for pending commands and executes registered handlers.
 */

import type { CaptureModule, Transport, CommandHandler, PendingCommand } from '../types';

// Global command registry
const commandRegistry = new Map<string, CommandHandler>();

/**
 * Register a command handler
 */
export function registerCommand(name: string, handler: CommandHandler | ((...args: unknown[]) => unknown | Promise<unknown>)) {
  if (typeof handler === 'function') {
    commandRegistry.set(name, { handler });
  } else {
    commandRegistry.set(name, handler);
  }
}

/**
 * Unregister a command handler
 */
export function unregisterCommand(name: string): boolean {
  return commandRegistry.delete(name);
}

/**
 * List registered commands
 */
export function listCommands(): Array<{ name: string; description?: string }> {
  return Array.from(commandRegistry.entries()).map(([name, cmd]) => ({
    name,
    description: cmd.description
  }));
}

/**
 * Get a registered command
 */
export function getCommand(name: string): CommandHandler | undefined {
  return commandRegistry.get(name);
}

/**
 * Create the command polling module
 */
export function captureCommands(
  transport: Transport,
  endpoint: string,
  pollInterval: number = 1000
): CaptureModule {
  // Extract base URL from events endpoint
  const baseUrl = endpoint.replace(/\/events\/?$/, '');
  const pendingUrl = `${baseUrl}/commands/pending`;
  
  let polling = true;
  let pollTimeout: ReturnType<typeof setTimeout> | null = null;
  
  async function pollCommands() {
    if (!polling) return;
    
    try {
      const response = await fetch(pendingUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const commands: PendingCommand[] = await response.json();
      
      for (const cmd of commands) {
        await executeCommand(cmd, baseUrl, transport);
      }
    } catch (error) {
      // Silently fail - server might not be running or support commands yet
      // Don't spam console with errors
    }
    
    if (polling) {
      pollTimeout = setTimeout(pollCommands, pollInterval);
    }
  }
  
  async function executeCommand(cmd: PendingCommand, baseUrl: string, transport: Transport) {
    const resultUrl = `${baseUrl}/commands/${cmd.id}/result`;
    const handler = commandRegistry.get(cmd.name);

    if (!handler) {
      // Command is not registered with *this* client — stay silent. Multiple
      // clients poll /commands/pending concurrently; if we posted an error
      // here, we'd mark the command `failed` in the DB before the client
      // that *does* have the handler can post its real result (race).
      // The client with the handler will claim the command via
      // POST /commands/:id/result. If no client has the handler, the command
      // stays `pending` and the submitter can see that from GET /commands/:id.
      return;
    }
    
    try {
      // Execute the handler
      const result = await handler.handler(...cmd.args);
      
      // Report success
      await fetch(resultUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result })
      });
      
      // Log the execution
      transport.send({
        _type: 'command.executed',
        command: cmd.name,
        args: cmd.args,
        result,
        commandId: cmd.id
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Report failure
      try {
        await fetch(resultUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: errorMessage })
        });
      } catch {
        // Ignore fetch errors
      }
      
      // Log the error
      transport.send({
        _type: 'command.error',
        command: cmd.name,
        args: cmd.args,
        error: errorMessage,
        commandId: cmd.id
      });
    }
  }
  
  // Start polling
  pollCommands();
  
  return {
    destroy() {
      polling = false;
      if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }
    }
  };
}
