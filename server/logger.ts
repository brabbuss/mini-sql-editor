export type LogFields = Record<string, unknown>;

/**
 * The logging interface the server depends on. `consoleLogger` is a placeholder:
 * a structured logger slots in by implementing these three methods.
 */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const consoleLogger: Logger = {
  info: (message, fields) => console.info(message, fields ?? {}),
  warn: (message, fields) => console.warn(message, fields ?? {}),
  error: (message, fields) => console.error(message, fields ?? {})
};
