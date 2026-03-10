import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { scoreDocument, fetchMarkdownContext } from '../src/retrieval.js';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';

describe('Retrieval logic', () => {
    test('scoreDocument calculates correct overlap', () => {
        const doc = {
            path: '/fake/path.md',
            filename: 'path.md',
            content: 'This document is about OpenClaw plugins and markdown retrieval.',
        };

        const prompt1 = 'How do I create an OpenClaw plugin?';
        expect(scoreDocument(prompt1, doc)).toBeGreaterThan(0);

        const prompt2 = 'Where can I find the best pizza?';
        expect(scoreDocument(prompt2, doc)).toBe(0);
    });

    describe('fetchMarkdownContext', () => {
        let tmpDir: string;

        beforeEach(() => {
            // Create a temporary directory structure for testing
            tmpDir = mkdtempSync(join(os.tmpdir(), 'contexto-retrieval-test-'));

            writeFileSync(join(tmpDir, 'apple.md'), 'Apples are red, crunchy, and sweet fruits.');
            writeFileSync(join(tmpDir, 'banana.md'), 'Bananas are long, yellow, and great for smoothies.');

            const subDir = join(tmpDir, 'sub');
            mkdirSync(subDir);
            writeFileSync(join(subDir, 'cherry.md'), 'Cherries are small, round, and often red. Good for pie.');
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        test('retrieves relevant documents', async () => {
            const prompt = 'Tell me about red fruits like apples and cherries.';
            const context = await fetchMarkdownContext(prompt, tmpDir);

            expect(context).toBeDefined();
            expect(context).toContain('## Reference Knowledge');
            expect(context).toContain('apple.md');
            expect(context).toContain('cherry.md');

            // banana.md shouldn't match strongly
            expect(context).not.toContain('banana.md');
        });

        test('returns undefined for irrelevant prompts', async () => {
            const prompt = 'How do I build a spaceship?';
            const context = await fetchMarkdownContext(prompt, tmpDir);

            expect(context).toBeUndefined();
        });

        test('handles missing or empty folders gracefully', async () => {
            const context = await fetchMarkdownContext('apples', '/does/not/exist/999');
            expect(context).toBeUndefined();
        });
    });
});
