import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startPath: string): string {
  let cur = startPath;
  while (cur !== dirname(cur)) {
    if (existsSync(join(cur, '.env.example')) && existsSync(join(cur, 'package.json'))) return cur;
    cur = dirname(cur);
  }
  return process.cwd();
}

dotenv.config({ path: join(findProjectRoot(__dirname), '.env') });

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required');
  process.exit(1);
}

export const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:4005';
export const PORT = parseInt(process.env.OPENROUTER_PORT || '4010', 10);
