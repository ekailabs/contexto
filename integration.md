Architecture Overview
┌─────────────────────────────────────────────────────────────────────────┐
│                         YOUR INFRASTRUCTURE                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────┐     ┌─────────────────────┐    ┌──────────────┐  │
│  │  contexto-website │────▶│    API Server      │───▶│   Database   │  │
│  │    (Vercel)      │     │   (AWS ECS/EC2)     │    │  (PostgreSQL) │  │
│  │                  │     │                     │    │  + Drizzle    │  │
│  │  - Marketing     │     │  - Auth middleware │    │              │  │
│  │  - Auth (Supabase)│    │  - API key validation│   │  Tables:     │  │
│  │  - Dashboard     │     │  - Usage tracking   │    │  - api_keys  │  │
│  │  - API Key UI    │     │  - Rate limiting    │    │  - usage     │  │
│  └────────┬─────────┘     │  - Memory + Proxy   │    │  - users     │  │
│           │               └──────────┬────────────┘    └──────────────┘  │
│           │                          │                                     │
│           │                   ┌──────┴──────┐                            │
│           │                   │   Users     │                            │
│           │                   │             │                            │
│           │                   │  OpenClaw   │                            │
│           │                   │  + Plugin   │                            │
│           │                   │             │                            │
│           │                   │ curl -H "Authorization: Bearer ck_xxx" │ │
│           └──────────────────▶│  http://api.getcontexto.com           │ │
│                                └──────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
---
Phase 1: Database Setup with Drizzle
Goal: Set up PostgreSQL + Drizzle ORM for all data
Task	Description
1.1	Choose DB: PostgreSQL on RDS or Supabase (easier, already have Supabase)
1.2	Install drizzle-orm, drizzle-kit in contexto/integrations/openrouter
1.3	Create schema in src/db/schema.ts:
// schema.ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  supabaseId: text('supabase_id').unique(),  // link to Supabase auth
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),  // "ck_live_xxxx" - first 8 chars
  userId: uuid('user_id').references(() => users.id).notNull(),
  name: text('name'),  // "production", "dev"
  createdAt: timestamp('created_at').defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
  isActive: boolean('is_active').default(true),
  monthlyLimit: integer('monthly_limit'),  // for rate limiting
});
export const usageLogs = pgTable('usage_logs', {
  id: serial('id').primaryKey(),
  keyId: uuid('key_id').references(() => apiKeys.id).notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costCents: integer('cost_cents'),
  timestamp: timestamp('timestamp').defaultNow(),
});
Task	Description
1.4	Create migration scripts and seed data
1.5	Set up connection pooling (pgBouncer for Supabase)
---
Phase 2: API Key Management System
Goal: APIs for creating, listing, revoking API keys
Task	Description
2.1	Create src/services/api-key-service.ts:
2.2	Generate key: ck_live_<uuid_v4> → hash with SHA-256 → store hash + prefix
2.3	List keys: GET /api/keys - return user's keys (no secrets)
2.4	Create key: POST /api/keys - generate new key, return ONCE (never again)
2.5	Revoke key: DELETE /api/keys/:id - soft delete (is_active = false)
2.6	Validate key: Internal function for middleware
// Generate key
function generateApiKey(): { plain: string; hash: string; prefix: string } {
  const plain = `ck_live_${uuidv4()}`;
  const hash = sha256(plain);
  const prefix = plain.slice(0, 12);  // ck_live_a1b2c3d4
  return { plain, hash, prefix };
}
---
Phase 3: Auth Middleware for Proxy
Goal: Validate API keys on every proxy request
Task	Description
3.1	Create src/middleware/auth.ts:
3.2	Extract Authorization: Bearer <key> from request
3.3	Look up key hash in DB, check is_active = true
3.4	Attach userId to request for usage logging
3.5	Return 401 if invalid/expired/disabled
3.6	Apply to all proxy endpoints (/v1/chat/completions, /v1/messages)
// auth middleware
app.use('/v1', async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  
  const key = authHeader.slice(7);
  const result = await validateApiKey(key);
  if (!result.valid) {
    return res.status(401).json({ error: result.error });
  }
  
  req.userId = result.userId;  // attach for downstream
  next();
});
---
Phase 4: Usage Tracking & Rate Limiting
Goal: Track usage per API key for billing/limits
Task	Description
4.1	Create src/middleware/usage-tracker.ts
4.2	After proxy call, extract token counts from response
4.3	Log to usage_logs table
4.4	Calculate cost (use OpenRouter pricing data)
4.5	Implement rate limiting: check monthly_limit before request
4.6	Create usage API for dashboard: GET /api/usage?key_id=xxx&period=month
// Rate limiting check
async function checkRateLimit(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });
  
  const thisMonthUsage = await db.query.usageLogs.findFirst({
    where: and(
      eq(usageLogs.keyId, user.activeKeyId),
      gte(usageLogs.timestamp, startOfMonth())
    )
  });
  
  return thisMonthUsage < user.monthlyLimit;
}
---
Phase 5: Supabase Integration (Website ↔ API)
Goal: Connect website auth to API server
Task	Description
5.1	Sync users: When user signs up on website → call API to create user record
5.2	API route in website: /api/keys - calls API server to manage keys
5.3	JWT verification: API server validates Supabase JWT for admin routes
5.4	Webhooks: Supabase auth webhooks → sync user create/delete to API DB
Integration flow:
User signs up on website (Supabase Auth)
       │
       ▼
Website calls: POST https://api.getcontexto.com/users
  Headers: Authorization: Bearer <supabase_jwt>
       │
       ▼
API creates user record in PostgreSQL
       │
       ▼
User goes to Dashboard → "Create API Key"
       │
       ▼
Website calls: POST https://api.getcontexto.com/api-keys
       │
       ▼
API returns: { key: "ck_live_xxxx..." }
       │
       ▼
User configures OpenClaw plugin:
{
  "memoryApiUrl": "https://api.getcontexto.com",
  "memoryApiKey": "ck_live_xxxx..."
}
---
Phase 6: Website Updates
Goal: Update from waitlist to product + add dashboard
Task	Description
6.1	Update landing page: remove waitlist, add product features
6.2	Create /dashboard page:
6.3	- Show current plan + usage
6.4	- List API keys with copy button
6.5	- "Create new key" button
6.6	- Usage charts (this month)
6.7	Add /pricing page or section
6.8	Integrate Stripe for payments (optional for MVP - just show $20/mo)
---
Tech Stack Summary
Component
Database
ORM
Auth (website)
Auth (API)
API Server
Deployment
Website
---
### Implementation Order
1. **Phase 1** - Set up DB + Drizzle (2-3 hours)
2. **Phase 2** - API key CRUD (3-4 hours)
3. **Phase 3** - Auth middleware (2-3 hours)
4. **Phase 4** - Usage tracking (2-3 hours)
5. **Phase 5** - Supabase integration (3-4 hours)
6. **Phase 6** - Website updates (4-6 hours)
**Total: ~17-23 hours**