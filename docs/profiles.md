# Profiles — design note

Status: proposal, not built. For review before implementation.

## The problem

The wrapper runs one child process per authenticated user, keyed on `userId`
(the `auth.userClaim` value from the login token, `sub` by default). Everything
follows from that key: `envPerUser` params are stored against it, and spawned
servers receive it as `MCP_USER_ID` to key their own storage.

One identity therefore means one upstream account, permanently. That is wrong
whenever a person legitimately has two accounts on the same service:

- a personal and a work Google account
- a personal WhatsApp and one belonging to an agent acting on their behalf
- two Airtable workspaces under different tokens

Today the only ways out are unpleasant. Register the same server twice in the
aggregator, which works for servers doing their own OAuth (`gmail`/`gmail-2`)
but not for wrapper-backed ones, since both registrations still resolve to the
same `userId` and therefore the same process and storage. Or run a second
deployment with a separate data root, duplicating infrastructure to hold one
extra credential. Or create a second identity in the upstream IDP, which means
inventing a fake person — with real login credentials to a real system — to
hold what is really just a second row in a table.

## The proposal

Introduce **profiles**: a user may have several named configurations, and each
connecting OAuth client is bound to exactly one.

    profiles:  (userId, profileId) → params, label
    bindings:  (userId, clientId)  → profileId

The process pool keys on `(userId, profileId)` rather than `userId`. Two
clients bound to the same profile share a process, as they do now; two clients
bound to different profiles get one each.

Note what is *not* here: no new notion of identity. The upstream IDP still
answers only "who is this", and only ever needs to say `adam`. "Which of your
accounts is this connection for" is a separate question the IDP has no opinion
about, and it is answered here.

### Why key bindings on `clientId`

Each MCP client that connects registers with the wrapper via dynamic client
registration and receives its own `clientId`. Notably, `mcp-aggregator`
registers per *upstream name*, so two registrations of the same URL
(`whatsapp` and `whatsapp-claube`) produce two distinct `clientId`s, and it
reuses a saved registration rather than minting a fresh one on reconnect.

So `clientId` is already a stable, per-connection identifier that the client
cannot choose for itself — it is issued by the wrapper and carried in the
wrapper's own sealed token, exactly like `userId`. That makes it a safe key.

The caveat is that the wrapper does not currently persist client registrations
(`registerClient` mints a UUID and returns it; `getClient` echoes back whatever
is presented). Stability today rests on the *client* remembering its
registration. For the aggregator that is durable — it stores registrations in
SQLite on a PVC. A client that forgot its registration and re-registered would
appear as a new client and hit the unbound-client path below, which is the
correct behaviour, but it does mean bindings are keyed on something the wrapper
does not itself guarantee. Persisting registrations would be a reasonable
follow-up; it is not required for this design.

### Choosing a profile: the Configure screen

There is already a Configure page shown mid-authorize when the server declares
`envPerUser` and the user has no values yet, plus a Reconfigure page for
editing them later. Both render the same fields.

Configure becomes the place where a connection is bound to a profile, and is
**always shown**, not only when `envPerUser` is declared.

That change matters. Of the six wrapper-backed servers in the reference
deployment, five declare `envPerUser` and already show the screen; `whatsapp`
is the only one that does not — and it is precisely the one where silently
binding to the default profile would link the wrong account. "No screen" today
means "no opportunity to choose", which is the failure case.

To keep it from becoming a pointless click:

- With one profile and no params, it is a single confirm-and-continue.
- With one profile and params, it is exactly today's form.
- With several profiles, a profile selector appears first, defaulting to the
  user's default profile, with the option to create a new one.

Deliberately excluded: rendering anything server-specific on this page (for
instance a WhatsApp QR code). The wrapper is generic and should not grow
knowledge of individual upstreams.

### Lifecycle

**First connection from an unknown client.** Configure is shown. The user
picks a profile or accepts the default; the binding is written on submit.

**Reconnection.** The binding already exists; the pool resolves the profile and
routes to its process.

**Creating a profile.** From Configure (during a connection) or Reconfigure
(later). A profile has a label and its own `envPerUser` values.

**Editing.** Reconfigure edits the params of a chosen profile. Changing a
profile's params invalidates the running process for that
`(userId, profileId)`, so the next request picks up new values — matching
today's behaviour on reconfigure.

**Deleting.** Requires rebinding: any clients bound to the deleted profile are
moved to the default profile. Deleting the default profile is refused while
other profiles exist. This avoids orphaned bindings pointing at nothing.

**Rebinding.** A client can be moved to a different profile via Reconfigure.
This invalidates its process so the next request routes to the new profile.

### Migration

Existing users have params stored against `userId` with no profile. On first
load, each becomes a profile named `default` holding those params, marked as
the user's default. Existing clients are bound to it lazily on next connection,
or eagerly if a binding table is backfilled — either way, current behaviour is
preserved: one profile, one process, same params, same `MCP_USER_ID`.

Servers that ignore profiles entirely are unaffected.

### What the child process sees

`MCP_USER_ID` keeps its current meaning: the authenticated identity. Servers
already keying storage on it continue to work unchanged.

A new `MCP_PROFILE_ID` carries the resolved profile. Servers that want
per-profile storage use both; servers that do not, ignore it. Both are set
after `envBase`/`envPerUser`, so neither can be overridden by a user-supplied
param.

Passing them as two variables is deliberate. They must not be concatenated into
one string by the wrapper, because downstream servers sanitise what they are
given, and sanitising a joined key can destroy the separator — see below.

## Related bug: `safe_user` is not injective

Independent of this design, `whatsapp-mcp-extended`'s `run_server.py` derives
its store directory as:

    safe_user = "".join(c if c.isalnum() or c in "-_" else "_" for c in user_id)

Every character outside `[A-Za-z0-9-_]` collapses to `_`, so distinct
identities can map to the same directory:

    adam@x.com  → adam_x_com
    adam.x.com  → adam_x_com

Two different users then share one WhatsApp account. The reference deployment
is currently safe only because Home Assistant issues 32-character hex ids —
but `auth.userClaim` is configurable, and pointing it at `email` or
`preferred_username` makes the collision reachable.

The fix is to encode rather than sanitise: a fixed-alphabet injective encoding
(URL-safe base64, or hex, of the UTF-8 bytes) cannot collide, needs no
escaping, and is reversible when debugging. Directory names become unreadable,
which for an internal store path is an acceptable trade.

This must be fixed before profiles ship, since `MCP_PROFILE_ID` would otherwise
flow through the same sanitiser and inherit the same collision.

## Open questions

1. Should the wrapper persist client registrations, so binding keys do not
   depend on clients remembering their own `clientId`?
2. Should profiles be creatable via the reconfigure *tool* as well as the web
   pages, so an agent can provision one without a browser?
3. Is a per-user cap on profiles worth having, given each one can hold a
   running process?
