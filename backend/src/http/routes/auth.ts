import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { issueToken, requireUser } from '../auth';
import { parseBody } from '../util';

export const authRouter = Router();

const LoginBody = z.object({ name: z.string().trim().min(1).max(50) });

/** Fake login: any name works; the user row is created on first login. */
authRouter.post('/login', async (req, res) => {
  const { name } = parseBody(LoginBody, req.body);
  // Upsert. "DO UPDATE SET name = EXCLUDED.name" is a no-op update that makes
  // RETURNING work for the already-exists case too.
  const [user] = await query<{ id: string; name: string; is_admin: boolean }>(
    `INSERT INTO users (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, is_admin`,
    [name],
  );
  const authUser = { id: user.id, name: user.name, isAdmin: user.is_admin };
  res.json({ user: authUser, token: issueToken(authUser) });
});

authRouter.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user });
});
