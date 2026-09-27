import { Router } from 'express';
import { z } from 'zod';
import { CHECKOUT_MODES, LOCK_STRATEGIES, config } from '../../config';
import { checkIntegrity, createEvent } from '../../booking/adminService';
import { DEFAULT_DROP_OPTIONS, runTicketDrop } from '../../sim/ticketDrop';
import { requireAdmin } from '../auth';
import { HttpError, parseBody, uuidParam } from '../util';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const CreateEventBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['CONCERT', 'MOVIE']),
  venue: z.string().trim().min(1).max(120),
  startsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date'),
  sections: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        rows: z.number().int().min(1).max(26), // rows A..Z
        seatsPerRow: z.number().int().min(1).max(50),
        priceCents: z.number().int().min(0).max(1_000_000),
      }),
    )
    .min(1)
    .max(10)
    .refine((secs) => new Set(secs.map((s) => s.name)).size === secs.length, 'section names must be unique'),
});

adminRouter.post('/events', async (req, res) => {
  const input = parseBody(CreateEventBody, req.body);
  const event = await createEvent(input);
  res.status(201).json({ event });
});

adminRouter.get('/integrity/:eventId', async (req, res) => {
  res.json({ integrity: await checkIntegrity(uuidParam(req, 'eventId')) });
});

const DropBody = z.object({
  requests: z.number().int().min(1).max(20_000).default(DEFAULT_DROP_OPTIONS.requests),
  concurrency: z.number().int().min(1).max(2_000).default(DEFAULT_DROP_OPTIONS.concurrency),
  users: z.number().int().min(1).max(5_000).default(DEFAULT_DROP_OPTIONS.users),
  hotSeats: z.number().int().min(1).max(500).default(DEFAULT_DROP_OPTIONS.hotSeats),
  seatsPerRequest: z.number().int().min(1).max(4).default(DEFAULT_DROP_OPTIONS.seatsPerRequest),
  strategy: z.enum(LOCK_STRATEGIES).default(DEFAULT_DROP_OPTIONS.strategy),
  mode: z.enum(CHECKOUT_MODES).default(DEFAULT_DROP_OPTIONS.mode),
  redisLock: z.boolean().default(true),
  confirm: z.boolean().default(true),
});

/**
 * Run a ticket drop from the admin UI. The simulator makes REAL HTTP requests
 * back to this API (localhost), so every layer is exercised. Because load
 * generator and server share one process here, latencies are a bit inflated;
 * `npm run ticket-drop` (separate process) gives cleaner numbers.
 */
// Per-process guard only (demo convenience, not shared state): stops one
// server from running two load generators on itself at once.
let dropRunning = false;
adminRouter.post('/ticket-drop', async (req, res) => {
  const opts = parseBody(DropBody, req.body ?? {});
  if (dropRunning) throw new HttpError(409, 'DROP_RUNNING', 'A ticket drop is already running on this server.');
  dropRunning = true;
  try {
    const report = await runTicketDrop({ ...opts, baseUrl: `http://127.0.0.1:${config.port}`, adminName: req.user!.name });
    res.json({ report });
  } finally {
    dropRunning = false;
  }
});
