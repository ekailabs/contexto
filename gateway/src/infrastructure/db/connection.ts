import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class DatabaseConnection {
  private db: Database.Database | null = null;

  constructor() {
    this.initialize();
  }

  private initialize() {
    try {
      // Use DATABASE_PATH env var, or default to data/proxy.db relative to cwd
      // In Docker: cwd = /app/gateway/ → /app/gateway/data/proxy.db (matches volume mount)
      // In dev:    cwd = gateway/     → gateway/data/proxy.db
      const dbPath = process.env.DATABASE_PATH || join(process.cwd(), 'data', 'proxy.db');
      const dbDir = dirname(dbPath);
      if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
      this.db = new Database(dbPath);
      
      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      
      // Create tables from schema
      this.createTables();
      
      logger.info('Database initialized', { operation: 'db_init', module: 'db-connection' });
    } catch (error) {
      logger.error('Database initialization failed', error, { operation: 'db_init', module: 'db-connection' });
      throw error;
    }
  }

  private createTables() {
    if (!this.db) throw new Error('Database not initialized');
    
    try {
      // Read and execute schema
      const schemaPath = join(__dirname, 'schema.sql');
      const schema = readFileSync(schemaPath, 'utf8');
      
      // Execute schema (split by semicolon and execute each statement)
      const statements = schema.split(';').filter(stmt => stmt.trim());
      statements.forEach(statement => {
        if (statement.trim()) {
          this.db!.exec(statement);
        }
      });

      // Lightweight migration: add payment_method column if missing
      const columns = this.db.prepare(`PRAGMA table_info(usage_records)`).all();
      const hasPaymentMethod = columns.some((c: any) => c.name === 'payment_method');
      if (!hasPaymentMethod) {
        this.db.exec(`ALTER TABLE usage_records ADD COLUMN payment_method TEXT DEFAULT 'api_key';`);
        logger.info('Added payment_method column to usage_records', { module: 'db-connection', operation: 'db_migration' });
      }
      
      logger.debug('Database tables created', { operation: 'db_schema', module: 'db-connection' });
    } catch (error) {
      logger.error('Failed to create tables', error, { operation: 'db_schema', module: 'db-connection' });
      throw error;
    }
  }

  getDatabase(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      logger.info('Database connection closed', { operation: 'db_cleanup', module: 'db-connection' });
    }
  }
}

// Export singleton instance
export const dbConnection = new DatabaseConnection();
export default dbConnection;
