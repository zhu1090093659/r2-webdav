# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

R2-WebDAV is a Cloudflare Worker that provides a WebDAV interface for Cloudflare R2 storage. It supports both single-user (legacy) and multi-user modes with per-user storage isolation.

## Commands

```bash
npm run dev      # Start local development server
npm run deploy   # Deploy to Cloudflare Workers
npm run format   # Format code with Prettier
npx wrangler deploy --dry-run  # Verify build without deploying
```

## Architecture

### Single File Structure
All worker logic is in `src/index.ts`. The code is organized into these sections:

1. **Types & Interfaces** - `Env`, `UserRecord` definitions
2. **Auth Utilities** - `parseBasicAuth`, `hashPassword`, `verifyPassword`, `generateSalt`
3. **UserScope Class** - Path isolation for multi-user mode, converts client paths to R2 keys with `username/` prefix
4. **WebDAV Handlers** - `handle_get`, `handle_put`, `handle_delete`, `handle_mkcol`, `handle_propfind`, `handle_proppatch`, `handle_copy`, `handle_move`
5. **Admin API** - `handleAdminApi` for user management (GET/POST/DELETE `/admin/users`)
6. **Admin UI** - `getAdminHtml` serves management interface at `/admin/`
7. **Registration** - `handleRegister` for self-registration at `/register`
8. **Main Export** - Request routing and authentication

### Authentication Modes

**Multi-user mode** (KV binding exists):
- Users stored in KV with `user:{username}` keys
- Passwords hashed with PBKDF2 (100k iterations, SHA-256)
- Each user's files isolated under `username/` prefix in R2

**Single-user mode** (legacy):
- Uses `USERNAME`/`PASSWORD` environment secrets
- No path prefix isolation

### Key Patterns

- **Timing-safe comparisons**: All password/token checks use `crypto.subtle.timingSafeEqual`
- **UserScope**: Converts client paths to R2 keys, prevents path traversal with `..` handling
- **HTMLRewriter**: Used to parse XML in PROPPATCH requests

## Environment Bindings

```toml
[[r2_buckets]]
binding = "bucket"

[[kv_namespaces]]
binding = "users"
```

**Secrets:**
- `ADMIN_TOKEN` - Required for admin API access
- `REGISTER_TOKEN` - Optional; if set, users must provide it to self-register
- `USERNAME`/`PASSWORD` - Legacy single-user mode only

## WebDAV Methods Supported

OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE

DAV compliance: Class 1, 3
