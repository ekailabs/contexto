import Stripe from 'stripe';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

export const STRIPE_EVENTS = {
  CHECKOUT_SESSION_COMPLETED: 'checkout.session.completed',
  CUSTOMER_SUBSCRIPTION_CREATED: 'customer.subscription.created',
  CUSTOMER_SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
  CUSTOMER_SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
} as const;

export async function handleStripeWebhook(payload: string, signature: string): Promise<{ received: boolean; error?: string }> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    console.error('[stripe] WEBHOOK_SECRET not configured');
    return { received: false, error: 'Webhook secret not configured' };
  }
  
  let event: Stripe.Event;
  
  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err);
    return { received: false, error: 'Invalid signature' };
  }
  
  console.log(`[stripe] Received event: ${event.type}`);
  
  switch (event.type) {
    case STRIPE_EVENTS.CHECKOUT_SESSION_COMPLETED: {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleCheckoutComplete(session);
      break;
    }
    
    case STRIPE_EVENTS.CUSTOMER_SUBSCRIPTION_CREATED:
    case STRIPE_EVENTS.CUSTOMER_SUBSCRIPTION_UPDATED: {
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionUpdate(subscription);
      break;
    }
    
    case STRIPE_EVENTS.CUSTOMER_SUBSCRIPTION_DELETED: {
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionDeleted(subscription);
      break;
    }
    
    case STRIPE_EVENTS.INVOICE_PAYMENT_FAILED: {
      const invoice = event.data.object as Stripe.Invoice;
      await handlePaymentFailed(invoice);
      break;
    }
    
    default:
      console.log(`[stripe] Unhandled event type: ${event.type}`);
  }
  
  return { received: true };
}

async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  const customerEmail = session.customer_email;
  
  console.log(`[stripe] Checkout complete: customer=${customerId} subscription=${subscriptionId}`);
  
  // Update user with Stripe info
  if (customerId) {
    await db.update(users)
      .set({
        stripeCustomerId: customerId,
        subscriptionStatus: 'active',
      })
      .where(eq(users.stripeCustomerId, customerId));
  }
}

async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;
  const status = mapStripeStatus(subscription.status);
  const items = subscription.items.data;
  
  // Get price ID to determine tier
  const priceId = items[0]?.price.id;
  const tier = mapPriceToTier(priceId);
  const limit = mapTierToLimit(tier);
  
  console.log(`[stripe] Subscription update: customer=${customerId} status=${status} tier=${tier}`);
  
  await db.update(users)
    .set({
      subscriptionStatus: status,
      subscriptionTier: tier,
      monthlyLimit: limit,
    })
    .where(eq(users.stripeCustomerId, customerId));
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;
  
  console.log(`[stripe] Subscription deleted: customer=${customerId}`);
  
  await db.update(users)
    .set({
      subscriptionStatus: 'canceled',
    })
    .where(eq(users.stripeCustomerId, customerId));
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;
  
  console.log(`[stripe] Payment failed: customer=${customerId}`);
  
  await db.update(users)
    .set({
      subscriptionStatus: 'past_due',
    })
    .where(eq(users.stripeCustomerId, customerId));
}

function mapStripeStatus(stripeStatus: string): 'active' | 'trialing' | 'past_due' | 'canceled' {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
      return 'canceled';
    default:
      return 'past_due';
  }
}

function mapPriceToTier(priceId?: string): 'starter' | 'personal' | 'enterprise' {
  const personalPriceId = process.env.STRIPE_PERSONAL_PRICE_ID;
  
  if (priceId === personalPriceId) {
    return 'personal';
  }
  
  return 'starter';
}

function mapTierToLimit(tier: string): number {
  switch (tier) {
    case 'personal':
      return 100000;
    case 'enterprise':
      return 1000000; // Arbitrary high limit
    default:
      return 10000;
  }
}

// Create checkout session
export async function createCheckoutSession(
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string
): Promise<Stripe.Checkout.Session> {
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  
  return session;
}

// Create customer
export async function createCustomer(email: string, metadata?: Record<string, string>): Promise<Stripe.Customer> {
  const customer = await stripe.customers.create({
    email,
    metadata,
  });
  
  return customer;
}

// Get subscription
export async function getSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch {
    return null;
  }
}