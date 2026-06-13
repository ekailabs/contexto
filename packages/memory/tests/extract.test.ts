import { describe, it, expect } from 'vitest';
import { labelSourceText } from '../src/providers/extract.js';

// `buildPrompt` is internal (not exported); these tests exercise the public
// `labelSourceText` plus the user-facing behaviour of the prompt primer via
// integration. Unit-level coverage of `labelSourceText` is enough to lock in
// the load-bearing rewrite that anchors first-person language to a userId.

describe('labelSourceText', () => {
  it('returns text unchanged when userId is undefined', () => {
    const text = 'User: hi\n\nAssistant: hello';
    expect(labelSourceText(text)).toBe(text);
  });

  it('returns text unchanged when userId is empty/whitespace', () => {
    const text = 'User: hi';
    expect(labelSourceText(text, '')).toBe(text);
    expect(labelSourceText(text, '   ')).toBe(text);
  });

  it('rewrites the line-leading "User: " label to "${userId}: "', () => {
    const text = 'User: my favorite color is teal';
    expect(labelSourceText(text, 'andrew')).toBe('andrew: my favorite color is teal');
  });

  it('rewrites every line-leading occurrence in a multi-turn transcript', () => {
    const text = 'User: hi\n\nAssistant: hello\n\nUser: bye';
    const out = labelSourceText(text, 'andrew');
    expect(out).toBe('andrew: hi\n\nAssistant: hello\n\nandrew: bye');
  });

  it('does not touch "User" inside message content (only the line-leading label)', () => {
    const text = 'User: I read the User Guide today';
    const out = labelSourceText(text, 'andrew');
    expect(out).toBe('andrew: I read the User Guide today');
  });

  it('does not match "User:" mid-line (e.g. inside quoted text)', () => {
    const text = 'User: yesterday I saw "User: hi" in a log';
    const out = labelSourceText(text, 'andrew');
    // The leading "User: " is rewritten, the quoted one is left alone.
    expect(out).toBe('andrew: yesterday I saw "User: hi" in a log');
  });

  it('trims surrounding whitespace from userId before substituting', () => {
    expect(labelSourceText('User: hi', '  andrew  ')).toBe('andrew: hi');
  });

  it('handles userIds with hyphens, underscores, dots, digits', () => {
    const text = 'User: hi';
    expect(labelSourceText(text, 'andrew-miller')).toBe('andrew-miller: hi');
    expect(labelSourceText(text, 'user_42')).toBe('user_42: hi');
    expect(labelSourceText(text, 'first.last')).toBe('first.last: hi');
  });
});
