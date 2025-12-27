# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

Use Cloudflare Workers to provide a WebDav interface for Cloudflare R2.

## Usage

Change wrangler.toml to your own.

```toml
[[r2_buckets]]
binding = 'bucket' # <~ valid JavaScript variable name, don't change this
bucket_name = 'webdav'
```

### Single-User Mode (Legacy)

For simple single-user setup, use environment secrets:

```bash
wrangler deploy

wrangler secret put USERNAME
wrangler secret put PASSWORD
```

### Multi-User Mode

For multi-user setup with per-user isolation, configure KV namespace:

1. Create KV namespace:

```bash
wrangler kv namespace create users
```

2. Update `wrangler.toml` with the returned namespace ID:

```toml
[[kv_namespaces]]
binding = "users"
id = "YOUR_KV_NAMESPACE_ID"
```

3. Set admin token for management API:

```bash
wrangler secret put ADMIN_TOKEN
```

4. Deploy:

```bash
wrangler deploy
```

## Admin API

When multi-user mode is enabled, you can manage users via the Admin API.

### Create User

```bash
curl -X POST https://your-worker.workers.dev/admin/users \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secret123"}'
```

### List Users

```bash
curl https://your-worker.workers.dev/admin/users \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Delete User

```bash
curl -X DELETE https://your-worker.workers.dev/admin/users/alice \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## User Self-Registration

Users can register themselves via the `/register` endpoint.

### Public Registration (No Token Required)

By default, if no `REGISTER_TOKEN` is set, anyone can register:

```bash
curl -X POST https://your-worker.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{"username": "newuser", "password": "mypassword"}'
```

### Token-Protected Registration

To require an invitation token for registration, set `REGISTER_TOKEN`:

```bash
wrangler secret put REGISTER_TOKEN
```

Then users must provide the token when registering:

```bash
curl -X POST https://your-worker.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{"username": "newuser", "password": "mypassword", "token": "YOUR_REGISTER_TOKEN"}'
```

### Registration Rules

- Username: 1-64 characters, alphanumeric, dot, underscore, hyphen only
- Password: minimum 6 characters
- Self-registered users are not admins

## WebDAV Client Connection

Connect with any WebDAV client using Basic Auth:

- **URL**: `https://your-worker.workers.dev/`
- **Username**: Your username (e.g., `alice`)
- **Password**: Your password

In multi-user mode, each user's files are isolated under their own `username/` prefix in R2. Users cannot access each other's files.

## Development

With `wrangler`, you can build, test, and deploy your Worker with the following commands:

```sh
# run your Worker in an ideal development workflow (with a local server, file watcher & more)
$ npm run dev

# deploy your Worker globally to the Cloudflare network (update your wrangler.toml file for configuration)
$ npm run deploy
```

## Test

Use [litmus](https://github.com/notroj/litmus) to test.
