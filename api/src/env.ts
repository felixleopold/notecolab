import type { AuthUser } from './routes/middleware.js';

export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};
