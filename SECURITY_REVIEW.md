# Pyeonghwa: production-readiness review

Scope: private photos, `POST /conversations`, and a security and reliability
pass over the existing features. PayMongo was not touched.

## What was found and what changed

### 1. Photos were public

| Problem | Fix |
| --- | --- |
| `/uploads/...` was served to anyone who had (or guessed) the link | The public route is removed. Photos live in `UPLOAD_DIR` (default `backend/storage/uploads`), which is outside `backend/public`. The server refuses to start if `UPLOAD_DIR` is inside `public`. |
| No check on who reads a photo | New `GET /conversations/:id/images/:name`: needs a valid login **and** membership of that conversation. Non-members, missing photos and bad addresses all get the same `404`, so it can't be used to discover what exists. |
| A photo could be reused in another chat | The conversation id is part of the file path and of the stored address, so a photo can only be read through the conversation it was uploaded to, and the server refuses to attach it to a message in any other conversation. |
| Path traversal | File names must match `^[a-f0-9]{32}\.(jpg\|png\|webp)$` and ids must be whole numbers. Paths are built only from those, checked to stay inside the storage folder, and resolved with `realpath` so a symbolic link can't point outside it. |
| File type was checked loosely | The file's own bytes are checked (JPEG marker, PNG `IHDR`, WebP chunk). The name and the type the browser reports are ignored. GIF, SVG, HTML and others are refused. Limit: 5 MB. |
| Photos could be treated as web pages | Served with a fixed image type, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `inline`, and `Cache-Control: private, no-cache`. |
| Frontend used a plain `<img src>` | An `<img>` can't send the login token, so photos are now downloaded with the token (`src/privateImage.js`) and shown from a local address. The loader only ever requests the server's own photo addresses, so the token can't be sent anywhere else. The look of the chat is unchanged. |
| Panic left files behind | Panic now deletes the whole saved and temporary photo folder of each affected conversation. |

Photos already stored by the old version are moved into private storage when
the server starts, and their addresses in the database are rewritten.

### 2. `POST /conversations` left empty conversations behind

The handler inserted a new conversation, then always answered `403`, so every
refused request left a conversation with no members. Now it only **looks up**
the conversation you already have and never writes anything; a new conversation
only exists once a message request is accepted. The target id is validated
(whole positive number only), and empty conversations left over from the old
behaviour are removed at start-up. Message requests are also serialized per
pair of people, so a double-click can't create duplicate pending requests.

### 3. Security and reliability

| Area | Found | Changed |
| --- | --- | --- |
| Secrets | Server would start with no `JWT_SECRET` | Refuses to start without one; in production also refuses one shorter than 32 characters. Messages never show a value. No secrets are committed (checked the files and git history). |
| Tokens | Algorithm not pinned; `Bearer` not checked | HS256 only; strict `Bearer <token>`; payload checked. |
| Debug route | Public `/db-test` | Removed. `/health` shows nothing about the database. |
| Sign-up | No validation; duplicates gave a 500 | Username, email and password rules (password 8 to 72 bytes); case-insensitive duplicate check; clean `409`. |
| Login | No type checks; no brute-force limit; unknown users answered faster than wrong passwords | Type checks; lock-out after 10 wrong passwords per account and address; always runs bcrypt so timing doesn't reveal accounts. |
| Rate limits | None | Login, sign-up, user search, message requests, photo upload and download, plus per-user limits on socket messages, room joins, call invites and ICE messages. |
| Sockets | Any logged-in user could crash the whole server by sending an empty (`null`) payload to a call event (confirmed against the old code); no message length limit; payloads up to 1 MB | Every event checks its payload; messages max 2000 characters (the input box enforces it too); payloads capped at 100 KB. |
| Calls | A caller could keep someone "busy" forever | Server-side ring timeout of 60 seconds. |
| Errors | Invalid JSON returned an HTML error page with a stack trace | Always short JSON; unknown routes return JSON `404`; unhandled rejections are logged. |
| Headers | None | `nosniff`, `X-Frame-Options`, `Referrer-Policy`, HSTS on https; framework header removed. |
| Photo upload | Not a member gave `403`, which the app treats as "logged out" | Now `404`. |

SQL: every query is parameterized (no string-built SQL found).

## Upgrading

1. `cd backend && npm install` (adds `multer` and a test-only dependency).
2. Set `JWT_SECRET` in `backend/.env` to a long random value, for example
   `openssl rand -hex 32`. **Changing it logs everyone out.**
3. For production also set `NODE_ENV=production`, `CLIENT_ORIGIN` (your https
   address) and, behind a reverse proxy, `TRUST_PROXY=1`. Without `TRUST_PROXY`
   every visitor looks like the proxy and shares one rate-limit allowance.
4. Optional: `UPLOAD_DIR=/some/private/folder`. Back this folder up together
   with the database.
5. Start the server. It moves old photos, deletes old temporary photos, removes
   empty conversations, and says what it did. Files in the old
   `backend/uploads` that no message points to are left alone and are no longer
   served; delete that folder once you've checked the photos load.

Behaviour changes to know about: new accounts need a username of 3 to 30
letters, numbers, `.`, `-` or `_`, and a password of 8 or more characters.
Existing accounts are not affected. Photo addresses are now
`/conversations/<id>/images/<name>`. Anything that called `/db-test` or
`/uploads/...` directly must change.

## Tests

```
cd backend && npm test        # 84 tests
cd frontend && npm test       # 10 tests
```

The backend integration tests start the real server and need PostgreSQL (the
database in `backend/.env`, or set `TEST_DB_NAME`). They only create users
named `zt<random>...` and remove everything they made, but running them
against a throwaway database is still the safest. They are skipped with a
message if PostgreSQL isn't reachable. They cover: private photo access for
members, non-members and logged-out requests, path traversal, file type and
size limits, moving old photos, the panic button, conversation creation (no
leftovers, including 25 requests at once), message request permissions and
races, sign-up and login rules, lock-out, token forgery, error responses,
headers, CORS, socket abuse and start-up checks. Each key test was also
checked by putting the old bug back and confirming the test fails.

## Remaining risks

Not fixed, and worth knowing about before going live:

1. **Login token lives in `sessionStorage` and lasts 7 days.** A cross-site
   scripting bug would expose it, and there is no server-side log-out or
   revocation. The server doesn't re-check that the account still exists on each
   request. (React escapes message text, and no `innerHTML` is used.)
2. **Rate limits and call state are kept in memory.** They reset when the server
   restarts and are per process. Running several server copies needs a shared
   store such as Redis.
3. **Photo storage.** Photos are not encrypted at rest, not scanned for malware,
   and not re-encoded on the server (the web app re-encodes before upload, but a
   custom client could upload a JPEG with location data). There is no storage
   quota per user. Several servers need shared storage. Use an encrypted disk
   and file permissions.
4. **Panic and "Save chat history" affect both people** in a conversation by
   design, so one person can erase the other's messages.
5. **Joining a chat loads the whole history.** Very long chats will be slow;
   there is no paging.
6. **Accounts.** No email verification, password reset or two-factor login.
   Message requests can still be repeated up to the rate limit; there is no
   block or report.
7. **HTTPS is not handled by this app.** Put it behind a reverse proxy that
   provides it.
8. **The old pages in `backend/public`** (including a copy of the chat source)
   are still served. Remove that folder for production.
9. **Operations.** bcrypt cost is 10 (raise to 12 if your server allows). The
   base database tables aren't defined in the repository, and there is no
   migration tool beyond `migrate.js`. There is no audit log or monitoring.
10. **Testing limits.** Tests ran against a database whose base tables I
    recreated from the queries in the code, and without a real browser,
    camera, microphone or phone. Try the photo and call flows once on your own
    setup.
