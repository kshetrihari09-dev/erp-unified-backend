# Rate limiting — design, settings, operations

Code: `src/middleware/rateLimit/*` (limiters) · `src/config/rateLimitConfig.js` (validated env) ·
`nginx/nginx.production.conf` (edge) · frontend: `src/services/{rateLimitState,requestGuard,http}.ts`.

## 1. Who can answer 429, and how to tell them apart

| Layer | `X-RateLimit-Source` | `X-RateLimit-Limiter` | Body `code` | Log line |
|---|---|---|---|---|
| Backend traffic limiter | `app-limiter` | `user` `company` `ip` `auth_fail` `auth_register` `otp_send` `auth_refresh` `auth_sensitive` `reports` `scanner` `ocr_upload` `heavy_ops` | `RATE_LIMITED` | `rate_limit_rejected` |
| Backend business rule (PIN lockout, OTP quota) | `application` | – | `PIN_LOCKED`, `OTP_QUOTA_EXCEEDED` | `http_429_application` |
| nginx `limit_req` | `nginx` | `nginx` | `RATE_LIMITED` | nginx `error.log`: `limiting requests` |
| Hosting platform / CDN / upstream provider | *absent* | *absent* | *absent* (often HTML) | none in this app — check the platform's own logs |
| Browser itself (client cooldown gate) | `client` (synthetic, never sent) | – | `CLIENT_RATE_LIMIT_COOLDOWN` | none |

> A 429 with **none** of these headers never reached the app's limiter code.

## 2. Limiters (production defaults)

Every `/api/v1` request is counted **once** by Tier 1 and, on the routes listed, **once** by one Tier 2 limiter.
`/health` and `/api/v1/discovery/info` are mounted before the stack and are not limited. CORS preflight is not counted.

| Limiter | Applies to | Bucket | Window | Max | Counts |
|---|---|---|---|---|---|
| `user` | requests with a **verified** JWT | user id | 60 s | 300 | all |
| `company` | requests with a verified JWT | company id | 60 s | 1200 | all (ceiling over all its staff) |
| `ip` | requests **without** a valid JWT | IP (IPv6 → /64) | 60 s | 120 | all |
| `auth_fail` | `POST /auth/login`, `/auth/verify-otp` | IP | 15 min | 20 | **failures only** |
| `auth_register` | `POST /auth/register` | IP | 15 min | 10 | all |
| `otp_send` | `POST /auth/send-otp` | IP | 15 min | 10 | all (each send costs money) |
| `auth_refresh` | `POST /auth/refresh` | IP | 15 min | 60 | all |
| `auth_sensitive` | `POST /auth/verify-password`, `/security-pin`, `/add-contact`, `/add-phone`, `/revoke-sessions`; `PUT /auth/change-password` | user (IP if no JWT) | 15 min | 10 | **failures only** |
| `reports` | `/reports/*`, `/stock-register/*` (incl. exports) | user | 60 s | 90 | all |
| `scanner` | `/scanner/*` | user | 60 s | 180 | all |
| `ocr_upload` | `POST /purchase-scans` **only** | user | 5 min | 15 | all |
| `heavy_ops` | `POST /settings/backup/run`, `GET /settings/backup/:id/download` | user | 5 min | 10 | all |

Deliberately **not** specially limited: `GET /purchase-scans/:id` (OCR status poll — cheap read; baseline only),
`/auth/me`, `/auth/logout` (session plumbing; baseline only), `/cloud-storage/upload` (AutoCloudBackup uploads one PDF per
invoice — a tight cap would silently break backups during a billing rush).

**Sizing basis** (from reading the client; no production traffic metrics exist in the repo): a dashboard load ≈ 8–10
requests; POS product search ≈ one request per debounced (200 ms) typing burst; two background pollers ≈ 1 request/min each.
A busy cashier peaks well under 150 requests/min, so 300/min/user gives ~2× headroom while a runaway loop (≥ 5 req/s) trips
it inside a minute. **Re-tune from real data** — see §7.

Why the window is 60 s: the old 15-minute window turned any burst into a lock-out of up to 15 minutes. Credential endpoints
keep 15 min because brute force is slow.

## 3. Identity and IP — security model

* Identity = a Bearer JWT whose signature and expiry verify against `JWT_SECRET` (`rateLimit/identity.js`). Headers such as
  `X-User-Id`, query strings and bodies are never read. Forged / expired / `alg=none` / customer-kind tokens → no identity →
  the per-IP bucket. A client cannot pick, rotate or inflate its bucket. `authenticate` still does the DB checks afterwards.
* IP = `req.ip` only, never `X-Forwarded-For` directly. `TRUST_PROXY` (default `1`) = number of proxy hops in front of Node;
  Express takes the Nth entry **from the right**, so entries a client prepends are ignored. `TRUST_PROXY=true` is rejected in
  production. nginx **overwrites** `X-Forwarded-For` with `$remote_addr`.
* Login has no per-account lockout, so `auth_fail` is the only brute-force guard on `/auth/login`; it counts failures only so
  many staff sharing one shop IP don't exhaust each other.

### Verify `TRUST_PROXY` on the live deployment (cannot be verified from source)
Log in as owner/admin and call `GET /api/v1/diagnostics/rate-limits`, from a normal client (not from the server):
* `thisRequest.ip` must be **your real public IP**. If it is the proxy/CDN address (same for every user) → `TRUST_PROXY` is too
  low and the whole company shares one IP bucket. If it is something you can change by sending your own header → too high.
* `forwardedHops` is the number of trusted hops Express saw. nginx only = 1. CDN + nginx = 2. **Render/Vercel/other PaaS:**
  the platform's proxy chain length is not documented in this repo — use this endpoint to find the right number.

## 4. Environment variables (all validated at boot; invalid → server refuses to start)

`RATE_LIMIT_API_WINDOW_MS` `RATE_LIMIT_AUTH_WINDOW_MS` `RATE_LIMIT_OCR_UPLOAD_WINDOW_MS` `RATE_LIMIT_HEAVY_OPS_WINDOW_MS` ·
`RATE_LIMIT_USER_MAX` `_COMPANY_MAX` `_IP_MAX` `_AUTH_FAIL_MAX` `_OTP_SEND_MAX` `_REFRESH_MAX` `_SENSITIVE_MAX` `_REPORTS_MAX`
`_SCANNER_MAX` `_OCR_UPLOAD_MAX` `_HEAVY_OPS_MAX` · `TRUST_PROXY` · `RATE_LIMIT_STORE` (`memory`|`redis`) · `REDIS_URL` ·
`RATE_LIMIT_REDIS_PREFIX` · `RATE_LIMIT_LOG_REJECTIONS` · `RATE_LIMIT_DIAGNOSTICS_ROLES`.

**Legacy variables are ignored** (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`, `SCANNER_RATE_LIMIT_MAX`,
`REPORTS_RATE_LIMIT_MAX`, `OCR_RATE_LIMIT_MAX`) so a stale `RATE_LIMIT_MAX=100` on the hosting dashboard cannot keep the old
budget alive. The server logs `rate_limit_legacy_env_ignored` at boot if any are still set — delete them.

## 5. Redis (multi-instance only)
Memory counters are per process: with N instances the effective limit is N×. For N > 1 set `RATE_LIMIT_STORE=redis` and
`REDIS_URL`. Counters are atomic (Lua `INCR` + `PEXPIRE`). Outage behaviour: business limiters **fail open** (availability);
credential limiters (`auth_*`, `otp_send`) **fail closed** (brute-force guard never silently off → login errors until Redis returns).

## 6. Diagnostics
* Structured one-line JSON, `event: rate_limit_rejected` — `requestId, method, route` (templated, no query string),
  `limiter, keyType, reason, userId, companyId, ip, proxy{trustProxy,forwardedHops,viaTrustedProxy}, limit, used, remaining,
  windowMs, retryAfterSeconds, resetAt, durationMs, status`. Never logged: tokens, `Authorization`, passwords, OTPs, bodies, query strings.
* `event: http_429_application` for business-rule 429s.
* `GET /api/v1/diagnostics/rate-limits` (owner/admin): active limits, store status, proxy resolution, rejection counters since boot.
* Quick triage: `grep rate_limit_rejected app.log | jq -r '[.limiter,.keyType,.route]|@tsv' | sort | uniq -c | sort -rn | head`

## 7. Tuning
Look at `rate_limit_rejected` after a week. If one `user` is rejected on a legitimate workflow, raise `RATE_LIMIT_USER_MAX`
(or fix the client loop). Many `ip` rejections from one address with no JWT usually mean `TRUST_PROXY` is too low (§3) or
clients are sending requests with an expired token. Raise a limit only after looking at *who* and *which route*.
