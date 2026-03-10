import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// --- Simple Keyword Matching Retrieval Logic ---

export interface MarkdownDocument {
    path: string;
    filename: string;
    content: string;
}

/**
 * Recursively find all markdown files in a given folder.
 */
export function discoverMarkdownFiles(folderPath: string): MarkdownDocument[] {
    const docs: MarkdownDocument[] = [];
    try {
        const entries = readdirSync(folderPath);
        for (const entry of entries) {
            const fullPath = join(folderPath, entry);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                docs.push(...discoverMarkdownFiles(fullPath));
            } else if (stat.isFile() && fullPath.toLowerCase().endsWith('.md')) {
                try {
                    const content = readFileSync(fullPath, 'utf-8');
                    docs.push({ path: fullPath, filename: entry, content });
                } catch (e) {
                    // Ignore files that can't be read
                }
            }
        }
    } catch (e) {
        // If folder doesn't exist or can't be read, return empty
    }
    return docs;
}

/**
 * Basic keyword extraction: lowercase and split by non-word chars, filtering short words.
 */
function extractKeywords(text: string): string[] {
    const words = text.toLowerCase().split(/\W+/);
    return Array.from(new Set(words.filter((w) => w.length > 3)));
}

/**
 * Score a document against a prompt based on keyword overlap.
 */
export function scoreDocument(prompt: string, doc: MarkdownDocument): number {
    const promptKeywords = extractKeywords(prompt);
    const docKeywords = extractKeywords(doc.content);

    let score = 0;
    for (const pk of promptKeywords) {
        if (docKeywords.includes(pk)) {
            score += 1;
        }
    }
    return score;
}

/**
 * Fetch relevant markdown context for a given prompt from the knowledge folder.
 */
export async function fetchMarkdownContext(prompt: string, folderPath: string, maxFiles: number = 3): Promise<string | undefined> {
    const docs = discoverMarkdownFiles(folderPath);
    if (docs.length === 0) return undefined;

    // Score all documents
    const scoredDocs = docs.map(doc => ({
        doc,
        score: scoreDocument(prompt, doc)
    }));

    // Filter out zero scores and sort by descending score
    const relevantDocs = scoredDocs
        .filter(sd => sd.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxFiles);

    if (relevantDocs.length === 0) return undefined;

    // Format the output
    let context = '## Reference Knowledge\n\n';
    for (const { doc } of relevantDocs) {
        context += `### ${doc.filename}\n\`\`\`markdown\n${doc.content}\n\`\`\`\n\n`;
    }

    return context.trim();
}
