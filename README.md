# mcp-auth-wrapper

> **Note:** This project is experimental, unpublished, and a work in progress. APIs and configuration may change without notice.

Most MCP servers run over stdio and assume a single user. This wrapper turns any env-var-configured stdio MCP server into a multi-user streamable HTTP endpoint with full OAuth 2.1 support. Each user gets their own server process with their own environment variables (e.g. API keys), and authentication is delegated to an upstream OIDC provider.

This means you can self-host MCP servers and share them across multiple users or devices, with each user's credentials kept isolated. It works with Claude Code and any other MCP client that supports OAuth discovery.

## How it works

```
Client (Claude Code)     Wrapper                 Upstream OIDC (e.g. Keycloak)
    |                       |                        |
    |-- GET /mcp ---------->|                        |
    |<-- 401 + metadata ----|                        |
    |-- POST /register ---->|                        |
    |<-- client_id ---------|                        |
    |-- GET /authorize ---->|                        |
    |                       |-- redirect to -------->|
    |                       |   upstream /authorize  |
    |                       |                  user logs in
    |                       |<-- GET /callback ------|
    |                       |   (upstream code)      |
    |                       |                        |
    |                       | exchange code, get userId
    |                       |                        |
    |<-- redirect + code ---|                        |
    |-- POST /token ------->|                        |
    |<-- access_token ------|                        |
    |-- POST /mcp --------->| (proxied to stdio)     |
```

1. The client discovers the wrapper's OAuth endpoints via `/.well-known/oauth-authorization-server`
2. The wrapper redirects to the upstream OIDC provider for login
3. After login, the upstream redirects back to the wrapper's `/callback`
4. The wrapper exchanges the upstream code for an ID token, extracts the user identity
5. If the user is new and `envPerUser` params are configured, the wrapper shows a form to collect them (e.g. API keys)
6. The wrapper issues its own authorization code and redirects the client
7. The client exchanges the code for an access token
8. Subsequent MCP requests include the access token and are proxied to the user's stdio process

A **reconfigure** tool is automatically injected into the MCP server's tool list, letting users update their parameters (e.g. rotate an API key) without re-authenticating.

## Usage

Set `MCP_AUTH_WRAPPER_CONFIG` to a JSON config object and run:

```bash
MCP_AUTH_WRAPPER_CONFIG='{
  "command": ["npx", "-y", "airtable-mcp-server"],
  "auth": {"issuer": "https://auth.example.com"}
}' npx mcp-auth-wrapper
```

This will spin up a streamable HTTP MCP server on localhost:3000.

<details>
<summary>Other configuration methods</summary>

The env var can also point to a file path:

```bash
MCP_AUTH_WRAPPER_CONFIG=/path/to/config.json npx mcp-auth-wrapper
```

Or create `mcp-auth-wrapper.config.json` in the working directory — it's picked up automatically:

```bash
npx mcp-auth-wrapper
```

</details>

### Config

Only `command` and `auth.issuer` are required. Everything else has sensible defaults.

A full example looks like:

```json
{
  "command": ["npx", "-y", "airtable-mcp-server"],
  "auth": {
    "issuer": "https://keycloak.example.com/realms/myrealm",
    "clientId": "my-wrapper",
    "clientSecret": "...",
    "scopes": ["openid", "profile"],
    "userClaim": "preferred_username"
  },
  "envBase": {"NODE_ENV": "production"},
  "envPerUser": [
    {"name": "AIRTABLE_API_KEY", "label": "Airtable API Key", "secret": true}
  ],
  "storage": "/data/mcp.sqlite",
  "port": 3000,
  "host": "0.0.0.0",
  "issuerUrl": "https://mcp.example.com",
  "secret": "a-fixed-signing-key"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `command` | Yes | Command and arguments to spawn the stdio MCP server, as an array. |
| `auth.issuer` | Yes | OIDC issuer URL. Endpoints are auto-discovered via `/.well-known/openid-configuration`. |
| `auth.clientId` | No | OAuth client ID registered with the upstream provider. Defaults to `"mcp-auth-wrapper"`. |
| `auth.clientSecret` | No | OAuth client secret. Omit for public clients. |
| `auth.scopes` | No | Scopes to request. Defaults to `["openid"]`. |
| `auth.userClaim` | No | Claim from the upstream ID token to use as the user identifier. Defaults to `"sub"`. |
| `envBase` | No | Environment variables shared across all user processes. |
| `envPerUser` | No | Per-user env vars to collect during auth. Each has `name`, `label`, optional `description` and `secret`. |
| `storage` | No | `"memory"` (default), a file path for SQLite, or an inline user map object. See [Storage modes](#storage-modes). |
| `port` | No | Port to listen on. Defaults to `3000`. |
| `host` | No | Host to bind to. Defaults to `0.0.0.0`. |
| `issuerUrl` | No | Public URL of this wrapper (for OAuth metadata and upstream callback). Auto-detected if not set. Required when behind a reverse proxy. |
| `secret` | No | Signing key for tokens and OAuth state. A random key is generated at startup if not set. Set a fixed value to survive restarts and for horizontal scaling. |

### Storage modes

- **`"memory"`** (default) — User params stored in-memory. Dynamic registration allowed, but data is lost on restart.
- **`"/path/to/db.sqlite"`** — User params persisted to a SQLite file. Dynamic registration allowed, survives restarts.
- **`{...}` (inline object)** — User params hardcoded in config. No dynamic registration — all users must be pre-configured.

The entire auth and session layer is stateless — authorization codes, access tokens, refresh tokens, and MCP sessions carry no server-side state. All OAuth tokens are self-contained encrypted blobs (AES-256-GCM), and each MCP request gets a fresh transport with no session tracking. In-flight auth flows and existing tokens survive restarts if `secret` is set.

> **Horizontal scaling:** The only per-instance state is the process pool (one stdio subprocess per user). If a user hits a different instance, it simply spawns a new subprocess — this is transparent and correct. Set `secret` to the same value across instances and use SQLite on a shared filesystem (or inline storage) for user params, and you can run multiple instances behind a load balancer.

### Auth server examples

<details>
<summary>Keycloak</summary>

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://keycloak.example.com/realms/myrealm",
    "clientSecret": "..."
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Create an OpenID Connect client in your Keycloak realm. Set the redirect URI to `https://<wrapper-host>/callback`. Users are identified by `sub` (Keycloak user ID) by default. Set `auth.userClaim` to `preferred_username` to match by username instead.

</details>

<details>
<summary>Auth0</summary>

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://your-tenant.auth0.com",
    "clientId": "...",
    "clientSecret": "..."
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Create a Regular Web Application in Auth0. Add `https://<wrapper-host>/callback` as an allowed callback URL. The `sub` claim in Auth0 is typically prefixed with the connection type (e.g. `auth0|abc123`).

</details>

<details>
<summary>Authentik</summary>

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://authentik.example.com/application/o/myapp/",
    "clientSecret": "...",
    "userClaim": "preferred_username"
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Create an OAuth2/OpenID Provider in Authentik. Set the redirect URI to `https://<wrapper-host>/callback`.

</details>

<!--

NB: this does NOT currently work, because HA is not OIDC compliant. Am working on a wrapper for this!

<details>
<summary>Home Assistant</summary>

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://ha.example.com"
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Home Assistant's `sub` claim is the HA user ID (not the username). No `clientId` or `clientSecret` needed.

</details> -->

<details>
<summary>Inline users (no dynamic registration)</summary>

If you don't want users to self-register params, hardcode them in the `storage` field:

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://auth.example.com",
    "clientSecret": "..."
  },
  "storage": {
    "adam": {"API_KEY": "patXXX_adam"},
    "bob": {"API_KEY": "patXXX_bob"}
  }
}
```

Users are matched by the `auth.userClaim` (default: `sub`) from the upstream ID token.

</details>

## Future work

**OIDC upstream proxy** — A standalone utility that wraps any OAuth server (that doesn't support OIDC discovery) and exposes a standard `/.well-known/openid-configuration` endpoint. This would let the wrapper work with non-OIDC auth providers. It would accept upstream authorization/token/JWKS endpoint URLs as config, serve discovery metadata, and proxy auth requests through.

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
