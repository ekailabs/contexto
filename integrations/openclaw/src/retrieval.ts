import type { QMDStore } from '@tobilu/qmd';

/**
 * Fetch top-K relevant snippets from the knowledge folder using QMD.
 */
export async function fetchMarkdownContext(
    store: QMDStore,
    query: string,
    limit: number = 5
): Promise<string | undefined> {
    const results = await store.search({
        query,
        limit,
        rerank: true
    });

    if (!results || results.length === 0) {
        return undefined;
    }

    let context = '## Reference Knowledge (Selective)\n\n';
    for (const res of results) {
        const anyRes = res as any;
        const content = anyRes.snippet || anyRes.body || '';
        context += `### ${res.title}\n> ${res.context || ''}\n\n${content}\n\n`;
    }

    return context.trim();
}
