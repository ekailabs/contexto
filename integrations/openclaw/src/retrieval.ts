import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// --- Unconditional Retrieval Logic ---

export interface Document {
    path: string;
    filename: string;
    content: string;
}

/**
 * Recursively find all files in a given folder.
 */
export function discoverFiles(folderPath: string): Document[] {
    const docs: Document[] = [];
    let entries;
    try {
        entries = readdirSync(folderPath);
    } catch (e) {
        return docs;
    }

    for (const entry of entries) {
        if (entry.startsWith('.')) continue; // skip hidden files

        const fullPath = join(folderPath, entry);
        try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                docs.push(...discoverFiles(fullPath));
            } else if (stat.isFile()) {
                try {
                    const content = readFileSync(fullPath, 'utf-8');
                    // Simple heuristic to skip binary files
                    if (content.indexOf('\0') !== -1) continue;

                    docs.push({ path: fullPath, filename: entry, content });
                } catch (e) {
                    // Ignore files that can't be read
                }
            }
        } catch (e) {
            // Ignore stat errors for individual files so scanning continues
        }
    }
    return docs;
}

/**
 * Fetch all files from the knowledge folder and return as context strings.
 */
export async function fetchMarkdownContext(_prompt: string, folderPath: string): Promise<string | undefined> {
    const docs = discoverFiles(folderPath);
    if (docs.length === 0) return undefined;

    // Format the output
    let context = '## Reference Knowledge\n\n';
    for (const doc of docs) {
        const extMatch = doc.filename.match(/\.([^.]+)$/);
        const ext = extMatch ? extMatch[1] : 'text';
        context += `### ${doc.filename}\n\`\`\`${ext}\n${doc.content}\n\`\`\`\n\n`;
    }

    return context.trim();
}
