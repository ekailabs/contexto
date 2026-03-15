import { watch } from 'node:fs';
import { type QMDStore } from '@tobilu/qmd';

/**
 * Setup a watcher for the knowledge folder.
 * Rewritten using pure Promises to avoid 'await' syntax errors.
 */
export function setupKnowledgeWatcher(
    folderPath: string,
    store: QMDStore,
    logger: { info: (m: string) => void, warn: (m: string) => void }
) {
    let watchTimeout: NodeJS.Timeout | null = null;

    return watch(folderPath, { recursive: true }, (eventType, filename) => {
        if (filename && !filename.startsWith('.') && !filename.includes('~')) {
            if (watchTimeout) clearTimeout(watchTimeout);

            watchTimeout = setTimeout(() => {
                logger.info(`@ekai/contexto: Changes in ${filename}, syncing...`);
                store.update()
                    .then(() => store.embed())
                    .then(() => {
                        logger.info(`@ekai/contexto: Knowledge base synced.`);
                    })
                    .catch((e) => {
                        logger.warn(`@ekai/contexto: Sync failed: ${String(e)}`);
                    });
            }, 2000);
        }
    });
}

