import { db } from '../db/index.js';
import { apiKeys, users, usageLogs } from '../db/schema.js';
import { eq, and, gte, lt, asc, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Generate API key: ck_live_<uuid>
export function generateApiKey(): { plain: string; hash: string; prefix: string } {
  const plain = `ck_live_${uuidv4().replace(/-/g, '')}`;
  const hash = crypto.createHash('sha256').update(plain).digest('hex');
  const prefix = plain.slice(0, 15); // "ck_live_abc123d4"
  return { plain, hash, prefix };
}

// Hash API key for lookup
export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Create new API key for user
export async function createApiKey(userId: string, name?: string) {
  const { plain, hash, prefix } = generateApiKey();
  
  const [key] = await db.insert(apiKeys).values({
    keyHash: hash,
    keyPrefix: prefix,
    userId,
    name,
    isActive: true,
  }).returning();
  
  return { ...key, plain }; // Return plain key ONLY on creation
}

// List API keys for user (no plain keys)
export async function listApiKeys(userId: string) {
  return db.select({
    id: apiKeys.id,
    keyPrefix: apiKeys.keyPrefix,
    name: apiKeys.name,
    isActive: apiKeys.isActive,
    createdAt: apiKeys.createdAt,
    lastUsedAt: apiKeys.lastUsedAt,
  })
  .from(apiKeys)
  .where(eq(apiKeys.userId, userId))
  .orderBy(desc(apiKeys.createdAt));
}

// Revoke API key (soft delete)
export async function revokeApiKey(keyId: string, userId: string) {
  const [updated] = await db.update(apiKeys)
    .set({ isActive: false })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
    .returning();
  
  return updated;
}

// Validate API key and return user context
export async function validateApiKey(key: string): Promise<{
  valid: boolean;
  error?: string;
  userId?: string;
  user?: any;
  keyId?: string;
}> {
  if (!key || !key.startsWith('ck_live_')) {
    return { valid: false, error: 'Invalid API key format' };
  }
  
  const keyHash = hashKey(key);
  
  const result = await db.select({
    id: apiKeys.id,
    keyPrefix: apiKeys.keyPrefix,
    userId: apiKeys.userId,
    isActive: apiKeys.isActive,
    user: {
      id: users.id,
      email: users.email,
      subscriptionStatus: users.subscriptionStatus,
      subscriptionTier: users.subscriptionTier,
      monthlyLimit: users.monthlyLimit,
    },
  })
  .from(apiKeys)
  .innerJoin(users, eq(apiKeys.userId, users.id))
  .where(eq(apiKeys.keyHash, keyHash))
  .limit(1);
  
  if (result.length === 0) {
    return { valid: false, error: 'API key not found' };
  }
  
  const record = result[0];
  
  if (!record.isActive) {
    return { valid: false, error: 'API key is revoked' };
  }
  
  // Update last used
  await db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, record.id));
  
  // Check subscription status
  if (record.user.subscriptionStatus === 'canceled') {
    return { valid: false, error: 'Subscription is canceled' };
  }
  
  if (record.user.subscriptionStatus === 'past_due') {
    return { valid: false, error: 'Payment past due' };
  }
  
  return {
    valid: true,
    userId: record.userId,
    user: record.user,
    keyId: record.id,
  };
}

// Get usage for a key in current month
export async function getKeyUsage(keyId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const result = await db.select({
    totalInput: usageLogs.inputTokens,
    totalOutput: usageLogs.outputTokens,
    totalCost: usageLogs.costCents,
    requestCount: apiKeys.id,
  })
  .from(usageLogs)
  .where(and(
    eq(usageLogs.keyId, keyId),
    gte(usageLogs.timestamp, startOfMonth)
  ));
  
  const totals = result.reduce((acc, log) => ({
    inputTokens: acc.inputTokens + (log.totalInput || 0),
    outputTokens: acc.outputTokens + (log.totalOutput || 0),
    costCents: acc.costCents + (log.totalCost || 0),
    requestCount: acc.requestCount + 1,
  }), { inputTokens: 0, outputTokens: 0, costCents: 0, requestCount: 0 });
  
  return totals;
}

// Check if user has reached monthly limit
export async function checkRateLimit(userId: string): Promise<{
  allowed: boolean;
  remaining: number;
  limit: number;
}> {
  const [user] = await db.select({
    monthlyLimit: users.monthlyLimit,
  })
  .from(users)
  .where(eq(users.id, userId))
  .limit(1);
  
  if (!user) {
    return { allowed: false, remaining: 0, limit: 0 };
  }
  
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const usageResult = await db.select({
    totalRequests: apiKeys.id,
  })
  .from(usageLogs)
  .innerJoin(apiKeys, eq(usageLogs.keyId, apiKeys.id))
  .where(and(
    eq(apiKeys.userId, userId),
    gte(usageLogs.timestamp, startOfMonth)
  ));
  
  const totalRequests = usageResult.length;
  const remaining = Math.max(0, user.monthlyLimit - totalRequests);
  
  return {
    allowed: remaining > 0,
    remaining,
    limit: user.monthlyLimit,
  };
}

// Log usage after proxy request
export async function logUsage(keyId: string, model: string, inputTokens: number, outputTokens: number, costCents: number) {
  await db.insert(usageLogs).values({
    keyId,
    model,
    inputTokens,
    outputTokens,
    costCents,
  });
}

// Get or create user by Supabase ID
export async function getOrCreateUser(supabaseId: string, email: string) {
  const existing = await db.select().from(users).where(eq(users.supabaseId, supabaseId)).limit(1);
  
  if (existing.length > 0) {
    return existing[0];
  }
  
  const [user] = await db.insert(users).values({
    supabaseId,
    email,
    subscriptionTier: 'starter',
    subscriptionStatus: 'trialing',
    monthlyLimit: 10000,
  }).returning();
  
  return user;
}