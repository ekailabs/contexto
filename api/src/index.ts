import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { db } from './db/index.js';
import { users, apiKeys } from './db/schema.js';
import { authMiddleware } from './middleware/auth.js';
import { proxyToOpenRouter } from './lib/proxy.js';
import { handleStripeWebhook } from './lib/stripe.js';
import { createApiKey, listApiKeys, revokeApiKey, getOrCreateUser } from './services/api-key.service.js';

const app = express();
const PORT = process.env.PORT || 4010;

// Stripe webhook needs raw body
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

// CORS for other routes
const corsOrigins = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) ?? '*';
app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: '10mb' }));

// ============ PUBLIC ROUTES ============

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/db-test', async (_req, res) => {
  try {
    const result = await db.select().from(users).limit(1);
    res.json({ status: 'connected', users: result.length });
  } catch (error) {
    res.status(500).json({ status: 'error', error: String(error) });
  });
});

// ============ PROTECTED ROUTES (Require API Key) ============

// OpenAI-compatible proxy endpoint
app.post('/v1/chat/completions', authMiddleware({ checkRateLimit: true }), async (req, res) => {
  await proxyToOpenRouter(req, res, req.userContext!.keyId, req.userContext!.userId);
});

// Anthropic-compatible proxy endpoint
app.post('/v1/messages', authMiddleware({ checkRateLimit: true }), async (req, res) => {
  await proxyToOpenRouter(req, res, req.userContext!.keyId, req.userContext!.userId);
});

// ============ USER MANAGEMENT ROUTES (Supabase JWT auth) ============

// Get current user
app.get('/api/user', async (req, res) => {
  try {
    // TODO: Validate Supabase JWT from Authorization header
    // const token = req.headers['authorization']?.replace('Bearer ', '');
    
    res.json({ message: 'TODO: Implement Supabase JWT validation' });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Sync user from Supabase (called from website after signup)
app.post('/api/user/sync', async (req, res) => {
  try {
    const { supabaseId, email } = req.body;
    
    if (!supabaseId || !email) {
      return res.status(400).json({ error: 'Missing supabaseId or email' });
    }
    
    const user = await getOrCreateUser(supabaseId, email);
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============ API KEY ROUTES (Supabase JWT auth) ============

// List user's API keys
app.get('/api/keys', async (req, res) => {
  try {
    // TODO: Get userId from Supabase JWT
    // const userId = getUserIdFromToken(req.headers['authorization']);
    const userId = req.headers['x-user-id'] as string;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const keys = await listApiKeys(userId);
    res.json({ keys });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Create new API key
app.post('/api/keys', async (req, res) => {
  try {
    // const userId = getUserIdFromToken(req.headers['authorization']);
    const userId = req.headers['x-user-id'] as string;
    const { name } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const result = await createApiKey(userId, name);
    
    res.json({
      key: result.plain, // Only returned ONCE on creation
      keyId: result.id,
      name: result.name,
      createdAt: result.createdAt,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Revoke API key
app.delete('/api/keys/:id', async (req, res) => {
  try {
    // const userId = getUserIdFromToken(req.headers['authorization']);
    const userId = req.headers['x-user-id'] as string;
    const keyId = req.params.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    await revokeApiKey(keyId, userId);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============ USAGE ROUTES ============

// Get usage for user's keys
app.get('/api/usage', async (req, res) => {
  try {
    // const userId = getUserIdFromToken(req.headers['authorization']);
    const userId = req.headers['x-user-id'] as string;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const keys = await listApiKeys(userId);
    const usagePromises = keys.map(key => getKeyUsage(key.id));
    const usageResults = await Promise.all(usagePromises);
    
    res.json({
      keys: keys.map((key, i) => ({
        ...key,
        usage: usageResults[i],
      })),
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============ STRIPE WEBHOOK ============

app.post('/webhooks/stripe', async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    const result = await handleStripeWebhook(req.body, signature);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('[webhooks/stripe] error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ============ CHECKOUT ROUTES ============

// Create Stripe checkout session
app.post('/api/checkout', async (req, res) => {
  try {
    // TODO: Get user from Supabase JWT
    // const userId = getUserIdFromToken(req.headers['authorization']);
    const userId = req.headers['x-user-id'] as string;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { priceId, successUrl, cancelUrl } = req.body;
    
    if (!priceId) {
      return res.status(400).json({ error: 'Missing priceId' });
    }
    
    // Get user from DB to find Stripe customer ID
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // TODO: Create Stripe checkout session
    // const session = await createCheckoutSession(user.stripeCustomerId, priceId, successUrl, cancelUrl);
    // res.json({ sessionId: session.id, url: session.url });
    
    res.json({ message: 'TODO: Implement Stripe checkout session creation' });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`@ekai/api server listening on port ${PORT}`);
});

export default app;