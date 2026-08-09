# mcp-auth-wrapper

> Turn any local [MCP server](https://modelcontextprotocol.io/) into a multi-tenant hosted remote MCP, with per-user credentials.

Connecting AI agents to tools can help you and your team be more productive. [MCP servers](https://modelcontextprotocol.io/docs/learn/server-concepts) are a great way to do this — but many of them only run locally and require per-user setup (like API keys) that can be difficult for non-technical users. What if you want your whole team to use one, each with their own credentials?

mcp-auth-wrapper lets you do exactly this: it hosts any MCP server for multiple users with auth and configuration. Your team can login via your existing identity provider (Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak, etc.), provide their per-user config in a simple form interface, and mcp-auth-wrapper will automatically spin up the MCP for each user.

mcp-auth-wrapper works with Claude.ai, Claude Code and any other MCP client that supports remote servers.

For those interested in the technical details, mcp-auth-wrapper wraps stdio MCP servers that accept environment variables as [streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) servers with [OAuth 2.1](https://oauth.net/2.1/) / [OpenID Connect](https://openid.net/developers/how-connect-works/). By default, user credentials are held only in memory but can be persisted to sqlite - it is recommended to use an encrypted volume for storage if doing this. mcp-auth-wrapper is horizontally scalable for larger deployments, and can be run easily with npx, Docker, Docker Compose or Kubernetes.

## Usage

Set `MCP_AUTH_WRAPPER_CONFIG` to a JSON config object and run:

```bash
MCP_AUTH_WRAPPER_CONFIG='{
  "command": ["npx", "-y", "airtable-mcp-server"],
  "auth": {"issuer": "https://auth.example.com"}
}' npx -y mcp-auth-wrapper
```

This starts an HTTP MCP server on localhost:3000. When a user connects, they'll be redirected to your login provider. After logging in, if you've configured per-user environment variables (like API keys), they'll see a form to enter them. Then they're connected to their own MCP server process.

<details>
<summary>Other configuration methods</summary>

The env var can also point to a file path:

```bash
MCP_AUTH_WRAPPER_CONFIG=/path/to/config.json npx -y mcp-auth-wrapper
```

Or create `mcp-auth-wrapper.config.json` in the working directory — it's picked up automatically:

```bash
npx -y mcp-auth-wrapper
```

</details>

<details>
<summary>Running with Docker</summary>

```bash
docker run -e 'MCP_AUTH_WRAPPER_CONFIG={"command":["npx","-y","airtable-mcp-server"],"auth":{"issuer":"https://auth.example.com"}}' -p 3000:3000 ghcr.io/domdomegg/mcp-auth-wrapper
```

</details>

<details>
<summary>Running on Kubernetes</summary>

The Docker image runs as the non-root `node` user (uid 1000). If you use a PersistentVolumeClaim for SQLite storage, the volume mount will be owned by root by default, so the container won't be able to write to it. Add `fsGroup: 1000` to the pod's security context to fix this:

```yaml
spec:
  securityContext:
    fsGroup: 1000
  containers:
    - name: mcp-auth-wrapper
      image: ghcr.io/domdomegg/mcp-auth-wrapper
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: mcp-auth-wrapper-data
```

</details>

### Config

Only `command` and `auth.issuer` are required. Everything else has sensible defaults.

A full example:

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
| `command` | Yes | Command to spawn the MCP server, as an array (e.g. `["npx", "-y", "some-server"]`). |
| `auth.issuer` | Yes | Your login provider's URL. Must support [OpenID Connect discovery](https://openid.net/specs/openid-connect-discovery-1_0.html). |
| `auth.clientId` | No | Client ID registered with your login provider. Defaults to `"mcp-auth-wrapper"`. |
| `auth.clientSecret` | No | Client secret. Omit for public clients. |
| `auth.scopes` | No | Scopes to request during login. Defaults to `["openid"]`. |
| `auth.userClaim` | No | Which field from the login token identifies the user. Defaults to `"sub"`. |
| `envBase` | No | Environment variables shared across all user processes. |
| `envPerUser` | No | Per-user env vars to collect during first login (e.g. API keys). Each has `name`, `label`, optional `description` and `secret`. |
| `storage` | No | Where to store user params: `"memory"` (default), a SQLite file path, or an inline object (see [below](#other-examples)). |
| `port` | No | Port to listen on. Defaults to `3000`. |
| `host` | No | Host to bind to. Defaults to `0.0.0.0`. |
| `issuerUrl` | No | Public URL of this server. Required when behind a reverse proxy. |
| `secret` | No | Signing key for tokens. Random if not set. Set a fixed value to survive restarts. |

Users can update their per-user env vars at any time via a **reconfigure** tool that's automatically added to the MCP server's tool list.

Each spawned server process also receives an `MCP_USER_ID` environment variable set to the authenticated user's identity (the `auth.userClaim` value, `sub` by default). Servers can use this to key per-user state — for example, a distinct storage directory per user. It is set after `envBase`/`envPerUser`, so it cannot be overridden by a user-supplied value.

### Profiles

One identity often needs more than one account on the same upstream — a personal and a work Google account, or a second WhatsApp for an agent acting on your behalf. A **profile** is one such account: it holds its own `envPerUser` values and gets its own server process.

Every user starts with a single profile named `default`, which behaves exactly as before profiles existed. Additional ones are created from the Configure screen shown while connecting a client.

Each connecting OAuth client is **bound** to one profile, chosen when the client is authorized and keyed on its client id. Clients bound to the same profile share a process; only a deliberate second profile starts a second one.

> **Profiles are an organisational boundary, not a security boundary.** `MCP_USER_ID` is trustworthy — it comes from the verified upstream token, and no client can reach another user's data. `MCP_PROFILE_ID` is weaker: client ids are accepted as presented rather than being checked against a registry, and the profile selection is submitted with the form. So *within a single identity*, a client that knows another of your client ids can reach that profile. Use profiles to keep your own accounts apart; do not rely on them to isolate a party you would not trust with the whole identity.

Spawned processes receive `MCP_PROFILE_ID` alongside `MCP_USER_ID`. Servers that want per-account storage should use **both**, as separate path segments:

```
store/<MCP_USER_ID>/<MCP_PROFILE_ID>
```

Do not concatenate them into one string before sanitising it — sanitising a joined key can destroy the separator, and two distinct accounts then collapse into one. For the same reason, prefer encoding (e.g. base64url behind a marker outside your safe character set) over replacing unsafe characters: replacement is not injective, so `adam@x.com` and `adam.x.com` would otherwise share a directory.

Deleting a profile moves any clients bound to it back to the default; the default itself cannot be deleted.

<details>
<summary>Advanced: scaling and persistence</summary>

All auth state (tokens, sessions, in-flight logins) is stateless — tokens are self-contained encrypted blobs and each request gets a fresh transport. Nothing is stored server-side except user params (in `storage`) and the process pool (one subprocess per user).

To survive restarts, set `secret` to a fixed value and use a SQLite file or inline storage for user params.

To run multiple instances behind a load balancer, set `secret` to the same value across instances and point `storage` at a shared SQLite file (or use inline storage). If a user hits a different instance, it just spawns a new subprocess — this is transparent for stateless MCPs.

</details>

### Login provider examples

<details>
<summary>Google Workspace</summary>

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://accounts.google.com",
    "clientId": "...",
    "clientSecret": "..."
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Create OAuth 2.0 credentials in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Choose "Web application", add `https://<wrapper-host>/callback` as an authorized redirect URI. To restrict access to your organization, configure the OAuth consent screen as "Internal".

</details>

<details>
<summary>Microsoft Entra ID</summary>

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
    "clientId": "...",
    "clientSecret": "..."
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Register an application in the [Azure portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps). Add `https://<wrapper-host>/callback` as a redirect URI under "Web". Create a client secret under "Certificates & secrets". Replace `<tenant-id>` with your directory (tenant) ID.

</details>

<details>
<summary>Okta</summary>

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://your-org.okta.com",
    "clientId": "...",
    "clientSecret": "..."
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Create a Web Application in Okta. Set the sign-in redirect URI to `https://<wrapper-host>/callback`. The issuer URL is your Okta org URL (or a custom authorization server URL if you use one).

</details>

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

Create an OpenID Connect client in your Keycloak realm with client ID `mcp-auth-wrapper` (or set `auth.clientId` to match). Set the redirect URI to `https://<wrapper-host>/callback`. Users are identified by `sub` (Keycloak user ID) by default. Set `auth.userClaim` to `preferred_username` to match by username instead.

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

Create a Regular Web Application in Auth0. Add `https://<wrapper-host>/callback` as an allowed callback URL. Set `auth.clientId` to the Auth0 application's client ID. The `sub` claim in Auth0 is typically prefixed with the connection type (e.g. `auth0|abc123`).

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

Create an OAuth2/OpenID Provider in Authentik with client ID `mcp-auth-wrapper` (or set `auth.clientId` to match). Set the redirect URI to `https://<wrapper-host>/callback`.

</details>

<details>
<summary>Home Assistant (via hass-oidc-provider)</summary>

Home Assistant doesn't natively support OpenID Connect. Use [hass-oidc-provider](https://github.com/domdomegg/hass-oidc-provider) to bridge the gap — it runs alongside Home Assistant and adds the missing pieces.

```json
{
  "command": ["npx", "-y", "some-mcp-server"],
  "auth": {
    "issuer": "https://hass-oidc-provider.example.com"
  },
  "envPerUser": [{"name": "API_KEY", "label": "API Key", "secret": true}]
}
```

Point `auth.issuer` at your hass-oidc-provider instance (not Home Assistant directly). The `sub` claim is the Home Assistant user ID. No `clientId` or `clientSecret` needed.

</details>

### Other examples

<details>
<summary>Inline users (no self-registration)</summary>

By default, users enter their own credentials (e.g. API keys) via a form during first login, and can update them later via the reconfigure tool. If you'd rather hardcode all users upfront, use an inline `storage` object:

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

Users are matched by the `auth.userClaim` (default: `sub`) from the login token. Inline storage is read-only — users cannot update their own credentials.

</details>

## Upgrading to 2.0

2.0 adds [profiles](#profiles). Existing configuration is migrated automatically — params stored against a user become a profile named `default`, and clients that connected before profiles resolve to it — so no action is needed for the wrapper itself.

The breaking change is for **spawned servers**, which now also receive `MCP_PROFILE_ID`. A server that keys storage on `MCP_USER_ID` alone keeps working, but will share one store between a user's profiles, which defeats the point. To support profiles, use both as separate path segments:

```
store/<MCP_USER_ID>/<MCP_PROFILE_ID>
```

Two things to get right when adopting it:

- **Migrate existing data into the default profile's directory.** Everyone has a default profile, so the new segment moves every existing session down a level. Without a migration, a server that stores a login there finds an empty directory and behaves as though it is being set up for the first time. Move the old contents in on first run rather than exempting the default profile from the path scheme — an exemption is permanent, and leaves the default living somewhere different from every other profile forever.
- **Encode each segment separately.** Sanitising a joined key can destroy the separator, merging two accounts; and replacing unsafe characters is not injective, so `adam@x.com` and `adam.x.com` collide.

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
3. Wait for GitHub Actions to publish to the NPM registry and GHCR (Docker).
