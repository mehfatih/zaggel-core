// Augment Express Request with the authenticated principal (S1).
import 'express';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        orgId: string;
        role: string;
      };
    }
  }
}

export {};
