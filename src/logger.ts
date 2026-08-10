export type Logger = {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
};

function write(level: string, message: string, details?: unknown): void {
  const suffix = details === undefined ? '' : ` ${safeJson(details)}`;
  console.log(`${new Date().toISOString()} [${level}] ${message}${suffix}`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export const logger: Logger = {
  info: (message, details) => write('INFO', message, details),
  warn: (message, details) => write('WARN', message, details),
  error: (message, details) => write('ERROR', message, details),
};
