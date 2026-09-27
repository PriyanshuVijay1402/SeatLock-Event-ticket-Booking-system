# How to run SeatLock

This guide gets the ticket booking system running on your machine in about
5 minutes, step by step. The commands work on **Windows (PowerShell)**,
**macOS** and **Linux**. Where they differ, both versions are shown.

---

## 1. Install the prerequisites

| Tool | Why | Check it's installed |
|---|---|---|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Runs Postgres, Redis, the API, the worker and the website | `docker --version` |
| [Node.js 20+](https://nodejs.org/) *(optional)* | Only needed to run the load test from your own terminal, or for dev mode | `node --version` |

> **Start Docker Desktop before you continue.** It has to be running (whale icon
> in the taskbar or menu bar). If it isn't, every `docker` command fails with
> `failed to connect to the docker API` or `Cannot connect to the Docker daemon`.

---

## 2. Open a terminal in the project folder

```bash
cd path/to/pv
```

This is the folder that contains `docker-compose.yml`, `README.md` and the
`backend/` and `frontend/` folders. Check you're in the right place:

```bash
ls        # should list: backend  frontend  docker-compose.yml  README.md ...
```

---

## 3. Start everything

```bash
docker compose up -d --build
```

The first run takes a few minutes while it downloads images and builds the app.
Later runs take seconds. When it finishes, check that all 5 containers are up:

```bash
docker compose ps
```

You should see `postgres` and `redis` as **healthy**, and `api`, `worker` and
`frontend` as **Up**.

---

## 4. Load the sample data

```bash
docker compose exec api node dist/db/seed.js
```

Expected output:

```
[seed] users: admin (admin), alice, bob
[seed] event "The Midnight Echoes — World Tour" -> ... (286 seats)
[seed] event "Interstellar (IMAX re-release)" -> ... (160 seats)
[seed] event "Jazz Night at the Blue Room" -> ... (40 seats)
```

You only need to do this once. Running it again is harmless.

---

## 5. Open the app

Go to **http://localhost:8080** in your browser and log in with any name. No
password is needed.

| Name | What you can do |
|---|---|
| `alice`, `bob` | Browse events, pick seats, check out, see your bookings |
| `admin` | All of the above, plus the **Admin** tab: create events and run the ticket drop |

**Try this:** open the same event in two browser windows (one normal, one
private/incognito), logged in as `alice` and `bob`. Select a seat as alice and
click **Hold seats & checkout**. The seat turns amber in bob's window within
about a second.

To check the API directly from the terminal:

```bash
curl http://localhost:8080/api/health
```

> On Windows PowerShell, use `curl.exe` instead of `curl`. Plain `curl` is a
> PowerShell alias with different behavior.

---

## 6. Run the ticket-drop load test

This fires hundreds of simultaneous booking requests at the same few seats,
then prints a report proving that no seat was double-booked.

**Option A: inside Docker** (nothing else to install):

```bash
docker compose exec api node dist/scripts/ticketDrop.js --url http://localhost:4000
```

**Option B: from your own terminal** (needs Node.js):

```bash
cd backend
npm install
npm run ticket-drop -- --url http://localhost:8080
```

The end of the report should say:

```
 RESULT: PASS - zero double-bookings
```

More experiments. Add these flags to either command (with Option B, keep the
`--` after `npm run ticket-drop`):

```bash
# Compare both locking strategies x queue/direct mode, with a summary table
--compare

# Turn off the Redis lock so every request hits the database
--compare --no-redis-lock

# Worst case: 5,000 people fighting over ONE seat
--hot-seats 1 --requests 5000 --concurrency 1000 --users 2500 --no-redis-lock --no-confirm
```

See the README for the full list of flags.

---

## 7. Change settings (optional)

All the knobs (locking strategy, queue vs. direct, isolation level, pool size,
hold duration…) are in `docker-compose.yml`, under `x-backend-env`. For example,
to try the strictest isolation level:

```yaml
  BOOKING_ISOLATION: SERIALIZABLE
```

Then apply the change:

```bash
docker compose up -d
```

To run several API and worker copies (horizontal scaling):

```bash
docker compose up -d --scale api=3 --scale worker=2
```

---

## 8. See what's happening (logs)

```bash
docker compose logs -f api        # API requests and errors
docker compose logs -f worker     # queue worker + expired-hold sweeper
```

Press `Ctrl+C` to stop following the logs. The app keeps running.

---

## 9. Stop it

```bash
docker compose down          # stop everything, KEEP the data
docker compose down -v       # stop everything and DELETE all data (fresh start)
```

After `down -v`, repeat steps 3 and 4 to start again.

---

## 10. Deploy it for free (get a public URL)

This puts the app on the internet with **$0 free tiers**, using three services:

| Piece | Free service | What it runs |
|---|---|---|
| Website + API + queue worker | **[Render](https://render.com)** (free Web Service) | One Docker container built from `Dockerfile.deploy` |
| PostgreSQL | **[Neon](https://neon.tech)** (free plan) | The database |
| Redis | **[Redis Cloud](https://redis.io/try-free/)** (free 30 MB database) | Locks, queue, cache, rate limits |

> Free-tier limits and sign-up rules change often. The notes below describe
> these services as of writing. Check each pricing page before you rely on it.

**How it differs from running locally.** Locally, docker-compose runs the
website (nginx), the API and the worker as separate containers. Free hosts give
you **one** web service, so `Dockerfile.deploy` packs all three into one
container: `node dist/all.js` starts the API and the worker in the same process,
and the API also serves the built React site. The design is unchanged, since the
API and worker still talk to each other only through Redis. Only the packaging
is different.

### Step 1: Put the code on GitHub

Render deploys from a Git repository. In the `pv` folder:

```bash
git add .
git commit -m "SeatLock ticket booking system"
```

Create an **empty** repository on https://github.com/new (don't add a README),
then connect it and push. Replace `YOUR-USER/seatlock` with your repository:

```bash
git remote add origin https://github.com/YOUR-USER/seatlock.git
git push -u origin main
```

(`.gitignore` already excludes `node_modules`, `dist` and `.env`, so no secrets
or build output get pushed.)

### Step 2: Create the database (Neon)

1. Sign up at https://neon.tech and create a project (any name; pick the region
   closest to where you'll deploy on Render).
2. On the project dashboard, click **Connect**. **Turn OFF "Connection pooling"**
   and copy the connection string. It looks like:

   ```
   postgresql://USER:PASSWORD@ep-something-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

   **Why not the pooled one?** The pooled URL (host contains `-pooler`) goes
   through PgBouncer in *transaction* mode. The migration runner takes a
   session-level `pg_advisory_lock`, which doesn't work reliably through a
   transaction pooler. Our app already has its own pool (`DB_POOL_SIZE`), so
   the direct URL is right here.

3. Keep `?sslmode=require` at the end. Neon only accepts encrypted connections.

### Step 3: Create Redis (Redis Cloud)

1. Sign up at https://redis.io/try-free/ and create the **free** database
   (30 MB is plenty).
2. Open the database and note the **Public endpoint** (`host:port`) and the
   **password** of the `default` user (under *Security*).
3. Build your Redis URL:

   ```
   redis://default:YOUR_PASSWORD@redis-12345.c1.us-east-1-2.ec2.redns.redis-cloud.com:12345
   ```

   If you turned on TLS for the database, use `rediss://` (two s's) instead.
4. **Recommended:** in the database settings, set **Data eviction policy** to
   `noeviction`. BullMQ (the queue) needs Redis to never silently delete its
   keys. With another policy it logs a warning and can lose queued jobs if memory
   fills up.

> **Why not Upstash?** Upstash's free Redis also works with this code (use its
> `rediss://` URL). But BullMQ polls Redis constantly, even when idle, and
> Upstash's free plan limits commands per month, so the queue can use up the
> quota. Redis Cloud's free plan limits memory instead, which suits this app
> better.

### Step 4: Create the tables and sample data (from your terminal)

Run the seed script **on your machine**, pointed at Neon. It creates the tables
and the sample events/users (`admin`, `alice`, `bob`). Use the Neon connection
string from step 2:

macOS / Linux:

```bash
cd backend
npm install
export DATABASE_URL='postgresql://USER:PASSWORD@ep-....neon.tech/neondb?sslmode=require'
npm run seed
```

Windows PowerShell:

```powershell
cd backend
npm install
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@ep-....neon.tech/neondb?sslmode=require'
npm run seed
```

Keep the **single quotes**: passwords can contain characters your shell would
otherwise interpret.

### Step 5: Deploy the app (Render)

1. Create a secret for signing login tokens and copy the output:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Sign up at https://render.com (you can log in with GitHub), then click
   **New → Web Service** and pick your `seatlock` repository.
3. Fill in the form:

   | Setting | Value |
   |---|---|
   | Language / Runtime | **Docker** |
   | Branch | `main` |
   | Root Directory | *(leave empty)* |
   | Dockerfile Path | `./Dockerfile.deploy` |
   | Docker Build Context | `.` |
   | Instance Type | **Free** |

4. Under **Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 2 |
   | `REDIS_URL` | the Redis URL from step 3 |
   | `AUTH_SECRET` | the random string from step 5.1 |
   | `DB_POOL_SIZE` | `5` |
   | `WORKER_CONCURRENCY` | `4` |

   Don't set `PORT`: Render sets it and the app reads it automatically. Every
   other setting (`LOCK_STRATEGY`, `BOOKING_ISOLATION`, …) is optional and
   works exactly as in `docker-compose.yml`.
5. Click **Create Web Service**. The first build takes about 3–5 minutes. When
   the log shows

   ```
   [worker] consuming checkout queue, concurrency=4, rate=500/s
   [api] listening on :10000  strategy=pessimistic mode=queue ...
   ```

   your app is live at **`https://<your-service-name>.onrender.com`**.

### Step 6: Check it works

```bash
curl https://<your-service-name>.onrender.com/api/health
```

Open the URL in a browser, log in as `alice`, and book a seat. Then run a
**small** ticket drop against it from your terminal:

```bash
cd backend
npm run ticket-drop -- --url https://<your-service-name>.onrender.com --requests 200 --concurrency 30 --users 100
```

It should end with `RESULT: PASS - zero double-bookings`.

**Updating:** every `git push` to `main` makes Render rebuild and redeploy
automatically.

### Free-tier caveats

- **Render free services go to sleep** after about 15 minutes with no traffic.
  The next visit takes about 30–60 seconds while it wakes up. While asleep, the
  worker and expiry sweeper sleep too. That's safe: an expired hold is treated
  as free even before the sweeper runs, so no one can get stuck.
- **Tiny machine** (about 0.1 CPU, 512 MB RAM). Keep load tests small (a few
  hundred requests, concurrency ≤ 50). The big numbers in DESIGN.md came from a
  laptop. Please don't hammer free infrastructure: it's shared, and heavy load
  testing can break the providers' terms.
- **Neon suspends the database** when idle. The first query after a pause is a
  bit slower.
- The **admin UI's ticket drop** also works when deployed, but it generates
  the load from the same tiny instance, so latencies will look poor.
- The free setup has **one** container, so it doesn't show horizontal scaling.
  For that, use `docker compose up --scale api=3 --scale worker=2` locally
  (step 7).

### Alternatives

| Instead of | You can use | Notes |
|---|---|---|
| Render | **[Koyeb](https://www.koyeb.com)** free instance | Also deploys a Dockerfile from GitHub: set the Dockerfile path to `Dockerfile.deploy`, the port to `8000`, and add `PORT=8000` to the env vars. |
| Neon | **[Supabase](https://supabase.com)** free Postgres | Use the **direct** connection string or the **session** pooler (port `5432`), not the transaction pooler (port `6543`). Append `?sslmode=require`. |
| Neon | Render's free Postgres | Works, but free Render databases expire after a limited time (30 days at the time of writing). |
| Redis Cloud | Upstash | See the note in step 3 about command limits. |

Fly.io and Railway no longer offer permanent free tiers (trial credits / paid
plans at the time of writing).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `failed to connect to the docker API` / `Cannot connect to the Docker daemon` | Docker Desktop isn't running. Start it, wait until it says "running", and try again. |
| `port is already allocated` / `address already in use` for **8080**, **6379** or **5433** | Something else on your machine uses that port (often a locally installed Redis on 6379). Stop that program, or change the left-hand number in `ports:` in `docker-compose.yml`, e.g. `"8081:80"`, then open http://localhost:8081. |
| The website loads but shows no events | You skipped step 4. Run the seed command. |
| Ticket drop fails with `Could not log in as admin (did you run the seed?)` | Run the seed command (step 4). It is what makes `admin` an admin. |
| Load test shows lots of `429 RATE_LIMITED` | You're running the API outside Docker without the high IP limit. Set `RATE_LIMIT_IP_MAX=100000` (see dev mode below). |
| `npm: command not found` | Install Node.js, or use Option A for the load test (it needs only Docker). |
| Something is weird and you want a clean slate | `docker compose down -v`, then steps 3 and 4 again. |
| **Deployed:** Render log shows `ECONNREFUSED` / `password authentication failed` | Recheck `DATABASE_URL` in Render's Environment tab: the direct (non-pooled) Neon string, ending in `?sslmode=require`. |
| **Deployed:** log shows `[redis:main] ... WRONGPASS` or keeps reconnecting | Recheck `REDIS_URL`: `redis://default:PASSWORD@HOST:PORT`, or `rediss://` if TLS is on in Redis Cloud. |
| **Deployed:** site works but no events | You skipped step 10.4. Run `npm run seed` with `DATABASE_URL` pointing at Neon. |
| **Deployed:** first page load takes ~1 minute | Normal for Render's free tier waking up from sleep. |
| **Deployed:** holds never finish (spinner forever) | The worker isn't running. Make sure the Dockerfile Path is `./Dockerfile.deploy` (it starts `dist/all.js`, the API **and** the worker). |

---

## Dev mode (optional: edit the code with hot reload)

Run only the database and Redis in Docker, and the app directly with Node.js.
You'll need **three terminals**.

**Terminal 1: infrastructure + API**

macOS / Linux:

```bash
docker compose up -d postgres redis
cd backend
npm install
export DATABASE_URL=postgres://ticketing:ticketing@localhost:5433/ticketing
export RATE_LIMIT_IP_MAX=100000
npm run seed
npm run dev:api
```

Windows PowerShell:

```powershell
docker compose up -d postgres redis
cd backend
npm install
$env:DATABASE_URL = "postgres://ticketing:ticketing@localhost:5433/ticketing"
$env:RATE_LIMIT_IP_MAX = "100000"
npm run seed
npm run dev:api
```

**Terminal 2: worker** (set the same two variables first, as above):

```bash
cd backend
npm run dev:worker
```

**Terminal 3: website**

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. Code changes reload automatically. Stop each
terminal with `Ctrl+C`.

> Don't run dev mode and the full Docker stack's `api`/`worker` at the same
> time. Both workers would consume the same queue. Run `docker compose stop api
> worker frontend` first.
