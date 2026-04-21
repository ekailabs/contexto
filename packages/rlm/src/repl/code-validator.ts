/**
 * Validates model-generated code before it reaches the vm sandbox.
 * Rejects known escape patterns and dangerous constructs.
 */

const BLOCKED_PATTERNS = [
  // Prototype chain escapes
  /\.__proto__/,
  /\.constructor\.constructor/,
  /\[['"]constructor['"]\]/,
  /Object\.getPrototypeOf/,
  /Reflect\./,

  // Module system access
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bimport\s+/,

  // Process/system access
  /\bprocess\./,
  /\bglobalThis\b/,
  /\bFunction\s*\(/,

  // Filesystem
  /\bfs\b/,
  new RegExp('\\b' + 'child' + '_' + 'process' + '\\b'),
  /\bpath\b\./,

  // Network
  /\bfetch\s*\(/,
  /\bXMLHttpRequest/,
  /\bWebSocket/,

  // Timers (blocked — sandbox should not set intervals)
  /\bsetInterval\s*\(/,
];

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateCode(code: string): ValidationResult {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      return {
        valid: false,
        reason: `Blocked pattern detected: ${pattern.source}`,
      };
    }
  }

  return { valid: true };
}
