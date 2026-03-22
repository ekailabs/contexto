import { Request, Response, NextFunction } from 'express';
import { validateApiKey, checkRateLimit } from '../services/api-key.service.js';

// Extend Express Request to add user context
declare global {
  namespace Express {
    interface Request {
      userContext?: {
        userId: string;
        keyId: string;
        subscriptionTier: string;
        monthlyLimit: number;
        usageThisMonth?: number;
      };
    }
  }
}

export interface AuthOptions {
  requireActiveSubscription?: boolean;
  checkRateLimit?: boolean;
}

export function authMiddleware(options: AuthOptions = {}) {
  const {
    requireActiveSubscription = true,
    checkRateLimit: doRateCheck = true,
  } = options;
  
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Extract API key from Authorization header
      const authHeader = req.headers['authorization'];
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing or invalid Authorization header. Use: Authorization: Bearer ck_live_xxx',
        });
      }
      
      const apiKey = authHeader.slice(7); // Remove "Bearer " prefix
      
      // Validate the key
      const validation = await validateApiKey(apiKey);
      
      if (!validation.valid) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: validation.error,
        });
      }
      
      if (requireActiveSubscription) {
        if (!['active', 'trialing'].includes(validation.user!.subscriptionStatus)) {
          return res.status(403).json({
            error: 'Forbidden',
            message: `Subscription is ${validation.user!.subscriptionStatus}. Please renew.`,
          });
        }
      }
      
      // Check rate limit if enabled
      if (doRateCheck) {
        const rateCheck = await checkRateLimit(validation.userId!);
        
        if (!rateCheck.allowed) {
          return res.status(429).json({
            error: 'Rate Limit Exceeded',
            message: `Monthly request limit (${rateCheck.limit}) reached. Upgrade your plan.`,
            remaining: 0,
            limit: rateCheck.limit,
          });
        }
        
        // Attach rate limit info to request
        req.userContext = {
          userId: validation.userId!,
          keyId: validation.keyId!,
          subscriptionTier: validation.user!.subscriptionTier,
          monthlyLimit: validation.user!.monthlyLimit,
          usageThisMonth: rateCheck.remaining,
        };
      } else {
        req.userContext = {
          userId: validation.userId!,
          keyId: validation.keyId!,
          subscriptionTier: validation.user!.subscriptionTier,
          monthlyLimit: validation.user!.monthlyLimit,
        };
      }
      
      next();
    } catch (error) {
      console.error('[auth middleware] error:', error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Authentication failed',
      });
    }
  };
}

// Helper to require admin-level access (for managing other users)
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.userContext?.subscriptionTier !== 'enterprise') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
  }
  next();
}