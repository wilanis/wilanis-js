# @wilanis/access

A wilanis tree to include: who is calling, and what they may do. Two sign-in routes that verify a credential
against directories and both end in the tree's *own* token; refresh and sign-out; preferences kept in a
session with typed attributes; the policies other features gate their triggers with; and the command that
gives a one-time challenge its code. Pure JSON, judged by `wilanis check` like anything else in the host.

```
npm install @wilanis/access @wilanis/plugin-auth @wilanis/plugin-http
```

```json
"includes": [{ "from": "@wilanis/access", "features": ["access"] }]
```

## What the host does

1. **Bind `@access/domain/identity.port.json`** to its directories, in a feature of its own. The port has four
   operations: `verifyCustomer` and `verifyEmployee` (a directory's verdict on a credential), `issue` and
   `refresh` (the tree's tokens). One delegation each is enough:

   ```json
   { "port": "@access/domain/identity.port.json", "operations": {
       "verifyCustomer": { "run": "@auth/identity.port.json#verify", "in": { "connection": "@connections/customers.connection.json", "type": "@access/domain/Attributes.shape.json" } },
       "verifyEmployee": { "run": "@auth/identity.port.json#verify", "in": { "connection": "@connections/employees.connection.json" } },
       "issue": { "run": "@auth/token.port.json#issue" },
       "refresh": { "run": "@auth/token.port.json#refresh" } } }
   ```

   The connections are the host's, of any directory kind `@auth` grants: accounts written in the connection
   for development, an OIDC issuer for production. `wilanis check` says B002 until the port is bound. The
   customer directory must say which tenant each account belongs to -- `attributes.tenant` on an account
   written in the connection, a `tenant` claim from an OIDC issuer -- and `type` hands `verify` the shape that
   says so (`Attributes.shape.json`, exported): an account that does not say it fails the sign-in rather than
   opening a session with no tenant.

2. **Bind `@auth/state.port.json`**, the guard's memory, in a feature of its own (`features/state/`). `@auth`
   requires it and keeps every session and challenge through it; one delegation per operation, to the plugin's
   file store for one process:

   ```json
   { "port": "@auth/state.port.json", "operations": {
       "getSession":      { "run": "@auth/files.port.json#get",    "in": { "collection": "sessions",   "type": "@auth/SessionRecord.shape.json" } },
       "putSession":      { "run": "@auth/files.port.json#put",    "in": { "collection": "sessions",   "type": "@auth/SessionRecord.shape.json" } },
       "endSession":      { "run": "@auth/files.port.json#remove", "in": { "collection": "sessions",   "type": "@auth/SessionRecord.shape.json" } },
       "getChallenge":    { "run": "@auth/files.port.json#get",    "in": { "collection": "challenges", "type": "@auth/ChallengeRecord.shape.json" } },
       "putChallenge":    { "run": "@auth/files.port.json#put",    "in": { "collection": "challenges", "type": "@auth/ChallengeRecord.shape.json" } },
       "removeChallenge": { "run": "@auth/files.port.json#remove", "in": { "collection": "challenges", "type": "@auth/ChallengeRecord.shape.json" } } } }
   ```

   The feature lists `@auth/files.port.json#get`, `#put` and `#remove` under `effects`. `wilanis check` says B002
   (required by @auth) until the port is bound.

3. **Configure `@auth`** in `project.json`, with the session shape this tree ships and the `otp` method:

   ```json
   { "use": "@auth", "from": "@wilanis/plugin-auth", "settings": {
       "tokens": { "issuer": "...", "audience": "...", "secret": "{{secrets.jwt}}" },
       "session": "@access/domain/Session.shape.json",
       "challenge": { "methods": { "otp": { "obtain": "wilanis run @access/edge/issue-otp.trigger.json --challenge-id={id}" } } } } }
   ```

4. **Gate triggers** with the policies this tree exports, giving the guard the token where the trigger reads it:

   ```json
   "policies": [
     { "policy": "@access/edge/employees-only.policy.json", "in": { "token": "{{request.headers.authorization}}" } },
     "@access/edge/can-register.policy.json"
   ]
   ```

   `signed-in` allows any caller the token names; `employees-only` allows realm `employee`; `can-register`
   allows the `registrar` role; `otp-verified` allows a challenge answered on the call and challenges otherwise
   (`"in": { "challenge": { "id": "{{request.flags['challenge-id']}}", "code": "{{request.flags.code}}" } }`).
   A feature that attaches them declares `"dependsOn": ["access"]`.

## What it ships

- `POST /api/v1/auth-customers`, `POST /api/v1/auth-employees`: a username and password in, our token pair out,
  the access token also set as the `session` cookie. The sign-in graphs decide the realm (`customer`,
  `employee`) and write the directory's groups as roles; 401 as `bad_credentials`, 503 as `directory_unavailable`.
- `POST /api/v1/token/refresh`, `POST /api/v1/sign-out`, `GET|PUT /api/v1/me/preferences`.
- `Session.shape.json`: `displayName`, `realm` and `tenant` written at sign-in, `theme` written by the preferences
  route. A host's store may scope its records by `request.session.attributes.tenant` (RFC 0015), and nothing
  writes the tenant again (X105 refuses a graph that would).
  `wilanis describe @access/domain/Session.shape.json` lists who writes what.
- `wilanis run @access/edge/issue-otp.trigger.json --challenge-id=XXXX-XXXX`: gives an open challenge its code
  and prints it. A production profile binds `access.port.json#deliverCode` to whatever delivers the code instead.

## The session, file by file

- **What it holds:** `features/access/domain/Session.shape.json` -- `displayName`, `realm`, `tenant`, an optional
  `theme`.
  The host names this shape in the `@auth` settings (`"session"`), so every write is judged against it, at
  `wilanis check` (X103) and at run time.
- **Where it is born:** the `issued` node of `domain/sign-in-employee.graph.json` and `sign-in-customer.graph.json`
  calls `identity.port.json#issue` with the token's subject, realm and roles and an `attributes` object -- the
  session's first contents: `displayName` from the directory, `realm` from the graph's constant, and `tenant` from
  what the customer directory said about the account, or the constant `operator` for an employee. The binding
  delegates `issue` to `@auth/token.port.json#issue`, which opens the session and signs the token that names it.
- **How a graph finds it:** `edge/session.resolvers.json` reads `request.session.id` as `{{sid}}`, declared
  `required` because the `signed-in` policy proves the session is there.
- **How it is updated:** `data/write-theme.graph.json` runs `@auth/session.port.json#set` with `session: {{sid}}`,
  `values: { "theme": "{{in.theme}}" }` and the shape as `type`. Copy that node to write any attribute; `#remove`
  drops attributes, `#end` ends the session (`data/end-session.graph.json`), `#get` reads it
  (`data/read-session.graph.json`).
- **Who writes what:** `wilanis describe @access/domain/Session.shape.json` lists every writer and the attributes
  it gives.

## On its own

This directory is a complete tree: `features/access-dev` binds `identity.port.json` to the directories written in
`connections/`, and `@auth/state.port.json` to files under `.wilanis/auth` (bo / bo-pass holds `registrar`, cy / cy-pass only `viewer`, ana / ana-pass is a customer in `acme`, dee / dee-pass one in `globex`), so
`wilanis check .`, `wilanis rehearse .` and `wilanis start .` work here with `CUSTOMERS_JWT_SECRET` set. A host
that includes `["access"]` gets none of that: the dev feature and the connections stay behind.

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
