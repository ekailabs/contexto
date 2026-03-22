import { pgTable, uuid, text, boolean, integer, timestamp, serial, pgEnum } from 'drizzle-orm/pg-core';

export const subscriptionTierEnum = pgEnum('subscription_tier', ['starter', 'personal', 'enterprise']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'past_due', 'canceled', 'trialing']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  supabaseId: text('supabase_id').unique(),
  email: text('email').notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  subscriptionStatus: subscriptionStatusEnum('subscription_status').default('trialing'),
  subscriptionTier: subscriptionTierEnum('subscription_tier').default('starter'),
  monthlyLimit: integer('monthly_limit').default(10000), // 10K for starter
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(), // First 12 chars for display
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: text('name'), // "production", "dev"
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
});

export const usageLogs = pgTable('usage_logs', {
  id: serial('id').primaryKey(),
  keyId: uuid('key_id').references(() => apiKeys.id, { onDelete: 'cascade' }).notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  costCents: integer('cost_cents').default(0),
  timestamp: timestamp('timestamp').defaultNow(),
});

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type UsageLog = typeof usageLogs.$inferSelect;
export type NewUsageLog = typeof usageLogs.$inferInsert;