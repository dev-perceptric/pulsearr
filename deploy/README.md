# Deploying PulseARR on the Hostinger VPS

This is the runbook for step 7 of `docs/m0-plan.md`. It changes the shared production server that runs the other apps, so **get a yes before starting**. Every secret goes into a file on the server (chmod 600), never into the repo, chat or a ticket.

Server: Hostinger KVM 2, `45.90.109.7`. Each folder here is one Docker Compose project on the server:

| Folder here | On the server | What it is |
|---|---|---|
| `sb-pulsearr/` | `/docker/sb-pulsearr` | PulseARR's Supabase stack: Postgres, GoTrue, PostgREST, Envoy gateway |
| `sb-public/pulsearr.yml` | merged into `/docker/sb-public/docker-compose.yml` | The Caddy entry for `db.pulsearr.com` |
| `pulsearr-migrate/` | `/docker/pulsearr-migrate` | Runs new migrations from `main` |
| `pulsearr-web/` | `/docker/pulsearr-web` | The app at `app.pulsearr.com` |
| `pulsearr-worker/` | `/docker/pulsearr-worker` | The job worker |
| `pulsearr-backup/` | `/docker/pulsearr-backup` | Nightly database dump, copied to Backblaze B2 |
| `uptime/gatus-endpoint.yaml` | added to the `uptime` project's Gatus config | The health check |

Copy a folder with `scp -r deploy/<folder> root@45.90.109.7:/docker/`.

## Memory

| Container | Memory limit | From |
|---|---|---|
| `sb-pulsearr` db (Postgres 17) | 512 MB | Same image as the other stacks |
| `sb-pulsearr` auth (GoTrue) | 128 MB | Same |
| `sb-pulsearr` rest (PostgREST) | 128 MB | Same |
| `sb-pulsearr` api-gw (Envoy) | 128 MB | Same |
| `sb-public` pulsearr entry (Caddy) | 64 MB | Added to the shared file |
| `pulsearr-web` | 512 MB | `ghcr.io/dev-perceptric/pulsearr-web` |
| `pulsearr-worker` | 512 MB | `ghcr.io/dev-perceptric/pulsearr-worker` |
| `pulsearr-migrate` | 128 MB | Same as Arrowsterr's runner |
| `pulsearr-backup` | 128 MB | Mostly asleep; dumps once a night |

Real use is about 1 GB, so the server peaks near 6.4 GB of 8 GB. Check `free -m` and `docker stats --no-stream` before starting: stop if the server is already above 6 GB.

## Before the server

1. **Images exist.** `main` has passed Checks and Build images in GitHub Actions, so `ghcr.io/dev-perceptric/pulsearr-web:latest` and `pulsearr-worker:latest` exist. The server is already logged in to ghcr.io for the other apps' images (`docker pull ghcr.io/dev-perceptric/pulsearr-web:latest` proves it). If the pull is refused, give the token the server uses read access to the two new packages (GitHub > the package > Package settings > Manage access).
2. **DNS at Namecheap** (pulsearr.com > Advanced DNS). Add early: Let's Encrypt needs them to resolve.
   - `A` `app` → `45.90.109.7`
   - `A` `db` → `45.90.109.7`
   - The apex (`@`) and `www` stay on Hostinger web hosting at `191.101.228.21`. Don't change them.
   - Check: `dig +short app.pulsearr.com` and `dig +short db.pulsearr.com` both print `45.90.109.7`.
3. **Resend.** Add `pulsearr.com` as a domain in Resend and put its DKIM, SPF and return-path records in Namecheap. Wait until Resend shows it verified. Make one API key for PulseARR (sending access, this domain only).
4. **Google sign-in.** In Google Cloud, create an OAuth client (web) with the redirect address `https://db.pulsearr.com/auth/v1/callback` and `https://app.pulsearr.com` as an allowed origin.

## 1. The Supabase stack: `/docker/sb-pulsearr`

```bash
scp -r deploy/sb-pulsearr root@45.90.109.7:/docker/
ssh root@45.90.109.7
cd /docker/sb-pulsearr
```

1. **Fresh secrets.** Never reuse another stack's values. `make-keys.mjs` prints a full set (Postgres password, JWT secret, `anon` and `service_role` JWTs signed with it, and `sb_publishable_`/`sb_secret_` keys):
   ```bash
   docker run --rm -v "$PWD":/w node:22-alpine node /w/make-keys.mjs > .env && chmod 600 .env
   ```
   Then open `/docker/sb-arrowsterr/.env` next to it and **match `/docker/sb-arrowsterr/.env`'s key format**: the same variable names, and the same kind of key (JWTs, or `sb_publishable_`/`sb_secret_` keys the gateway swaps for JWTs). Delete the lines Arrowsterr doesn't have; add any it has that this file lacks, with new values.
2. **GoTrue settings.** `mkdir -p /opt/sb/pulsearr && cp auth.env.example /opt/sb/pulsearr/auth.env && chmod 600 /opt/sb/pulsearr/auth.env`, then fill it in:
   - SMTP through Resend: `smtp.resend.com`, port `465`, user `resend`, password = the Resend API key, sender `hello@pulsearr.com`, name `PulseARR`. Sign-in uses a 6-digit code (`GOTRUE_MAILER_OTP_LENGTH=6`).
   - Templates: each `GOTRUE_MAILER_TEMPLATES_*` is an https address GoTrue fetches the HTML from. Use PulseARR's templates from the repo (the sign-in work adds them, served by the app); each shows `{{ .Token }}`. Leave one empty and GoTrue sends its plain default for that kind. Copy the subjects from `auth.env.example`.
   - Google: the client ID and secret from "Before the server".
3. **The gateway config.** `docker-compose.yml` mounts `/opt/sb/files/envoy/envoy.yaml`, the way the other stacks do. Compare with `/docker/sb-arrowsterr/docker-compose.yml`: if Arrowsterr's api-gw mounts a different path or sets environment variables, copy from `/docker/sb-arrowsterr` and match it. If the Envoy file has a stack's keys written into it, copy it to `/docker/sb-pulsearr/envoy.yaml`, put PulseARR's keys in, and point the volume there.
4. Check the shared init scripts exist: `ls /opt/sb/files/db/` shows `webhooks.sql`, `roles.sql` and `jwt.sql`.
5. Start it and wait for the database to be healthy:
   ```bash
   docker compose up -d
   docker compose ps          # db shows (healthy); auth, rest and api-gw are Up
   docker network ls | grep sb-pulsearr
   ```

## 2. The public address: `sb-public`

1. `cp /docker/sb-public/docker-compose.yml /docker/sb-public/docker-compose.yml.bak`
2. Add the `pulsearr` service and the `pulsearr` network from `deploy/sb-public/pulsearr.yml` next to the other apps' entries.
3. `cd /docker/sb-public && docker compose config -q && docker compose up -d pulsearr` (only the new entry starts; the others aren't touched).
4. Check: `curl -s https://db.pulsearr.com/auth/v1/health -H "apikey: <publishable key>"` returns GoTrue's JSON.

**Traefik.** The web and Caddy entries carry Traefik labels and, like the Arrowsterr ones, join no named network. Check how Traefik reaches arrowsterr-web (`docker inspect arrowsterr-web-web-1 --format '{{json .NetworkSettings.Networks}}'`). If it's over a named network, add the same network to `pulsearr-web` and to the `pulsearr` Caddy entry.

## 3. Migrations: `/docker/pulsearr-migrate`

```bash
scp -r deploy/pulsearr-migrate root@45.90.109.7:/docker/
cd /docker/pulsearr-migrate
touch .env && chmod 600 .env
```

While the repo is private, put `GITHUB_TOKEN=` in `.env`: a fine-grained token with Contents read-only on `dev-perceptric/pulsearr` only. Leave `.env` empty once the repo is public.

```bash
docker compose up -d
docker logs -f pulsearr-migrate-migrate-1   # "Applied 001_...", then "Up to date at <commit>"
```

The runner checks `main` every 2 minutes and runs each new `supabase/migrations/NNN_*.sql` in filename order, one transaction per file, recording each in `ops.schema_migrations`. A file that fails is rolled back, its error is logged, and the runner stops there until the next push or 30 minutes. To run a file again, delete its row from `ops.schema_migrations`, then `docker compose restart`.

## 4. The app: `/docker/pulsearr-web`

```bash
scp -r deploy/pulsearr-web root@45.90.109.7:/docker/
cd /docker/pulsearr-web
```

Make `.env` (chmod 600) with every web line from the repo's `.env.example`:

- `SUPABASE_URL=https://db.pulsearr.com`
- `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`: from `/docker/sb-pulsearr/.env`, the same kind of key arrowsterr-web uses.
- `SECRETS_KEY`: `openssl rand -base64 32`, made once. Save a copy in the password manager: it is never rotated without a re-seal script, and the worker gets the same value.
- `RESEND_API_KEY`, `EMAIL_FROM=PulseARR <hello@pulsearr.com>`, `APP_URL=https://app.pulsearr.com`, `SITE_ORIGINS=https://pulsearr.com,https://www.pulsearr.com`, and `ANTHROPIC_API_KEY` (optional in M0).

```bash
docker compose pull && docker compose up -d
curl -s https://app.pulsearr.com/api/health
```

## 5. The worker: `/docker/pulsearr-worker`

```bash
scp -r deploy/pulsearr-worker root@45.90.109.7:/docker/
cd /docker/pulsearr-worker
```

Make `.env` (chmod 600): `DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD from /docker/sb-pulsearr/.env>@db:5432/postgres`, the same `SECRETS_KEY` as the web app, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`, and `WORKER_CONCURRENCY` if needed.

```bash
docker compose pull && docker compose up -d
docker logs --tail 50 pulsearr-worker-worker-1
```

## 6. Backups: `/docker/pulsearr-backup`

1. In Backblaze B2, make a private bucket (for example `pulsearr-backups`) with a lifecycle rule that keeps files 90 days (hide after 90 days, delete 1 day after hiding). Make an application key for that bucket only.
2. On the server:
   ```bash
   scp -r deploy/pulsearr-backup root@45.90.109.7:/docker/
   mkdir -p /opt/backups/pulsearr
   cd /docker/pulsearr-backup
   printf 'B2_KEY_ID=\nB2_APP_KEY=\nB2_BUCKET=pulsearr-backups\n' > .env && chmod 600 .env   # then fill in the key
   docker compose up -d
   docker compose exec backup bash /app/backup.sh now   # one dump now, to prove it
   ls -lh /opt/backups/pulsearr
   ```
   It then dumps every night at 03:15 UTC (`pg_dump -Fc`), keeps 14 days on the server, and copies each dump to B2. Without the B2 lines it keeps the server copies only.
3. Restore test, once: `pg_restore --list /opt/backups/pulsearr/<file>.dump | head` reads the file back.

## 7. Autodeploy and uptime

- **Autodeploy.** The shared `autodeploy` container pulls and restarts every project in its list every 300 seconds. Add `pulsearr-web pulsearr-worker` to that list (in the autodeploy project's compose file or script, wherever the other apps' project names are), then restart it. Don't write a new autodeploy. The migrate and backup runners aren't on the list: their images are fixed and their scripts come from these files.
- **Uptime.** Add the endpoint in `deploy/uptime/gatus-endpoint.yaml` to the Gatus config of the `uptime` project, with the same alerts as the other apps, then `docker compose restart` there.

## 8. Check it works

- [ ] `dig +short app.pulsearr.com` and `db.pulsearr.com` print `45.90.109.7`; `pulsearr.com` still shows the marketing site.
- [ ] `curl -s https://app.pulsearr.com/api/health` answers 200, with a valid certificate.
- [ ] `https://app.pulsearr.com/api/health/setup` shows every setting present.
- [ ] Sign in at `https://app.pulsearr.com/signin` with a real address: the email with the 6-digit code arrives from `hello@pulsearr.com` in PulseARR's template, the code signs in, and a workspace is made.
- [ ] Google sign-in works.
- [ ] Migrations ran: `docker exec sb-pulsearr-db-1 psql -U postgres -c 'select filename, applied_at from ops.schema_migrations order by 1'` lists every file in `supabase/migrations`.
- [ ] The worker is up: its log shows the minute tick and no errors.
- [ ] A backup file is in `/opt/backups/pulsearr` (and in B2 if set).
- [ ] Gatus shows the PulseARR check green.
- [ ] The next push to `main` reaches the server within about 5 minutes (`/api/version` shows the new commit).
- [ ] `free -m` stays under about 6.4 GB in use.

## Undo

Each project stops with `docker compose down` in its folder (add `-v` on `sb-pulsearr` only to delete the database too). Remove the `pulsearr` entry from `sb-public` (or restore the `.bak`), take `pulsearr-web pulsearr-worker` off the autodeploy list and the endpoint off Gatus, and delete the `app` and `db` records at Namecheap.
