# @wilanis/plugin-http

The `@http` plugin for wilanis: routes as triggers, outbound requests (`@http/http.port.json#request`), HTTP
connections, and body codecs (json, text, form, multipart). Who may call a route is not this plugin's business:
a trigger attaches its policies, giving the guard the token where the route reads it (a header, a cookie),
and the guarding plugin (`@wilanis/plugin-auth`) identifies the caller before the route's operation fires.

```
npm install @wilanis/plugin-http
```

```json
{ "use": "@http", "from": "@wilanis/plugin-http", "settings": {
    "port": 8080,
    "codecs": { "application/json": "@http/codecs/json.codec.json" } } }
```

Which codec handles which content type is the project's explicit table. Triggers say `consumes` and
`produces`; the plugin's `check` hook refuses (X001, X002) any content type the table does not cover.
`wilanis describe @http/http.trigger-kind.json` lays out the settings and the context a route hands.

Files never pass through the engine. A content type mapped to `@http/codecs/blob.codec.json` is streamed
into the tree's blob registry as it arrives, and the route's input is the handle (`blob`: id, contentType,
size, filename). A route whose `out` is `blob` and whose `produces` maps to the blob codec streams the file
back from the registry with its own content type and a `content-disposition` attachment. Multipart file
parts stream into the registry the same way and arrive as `blob` values beside the text fields. Every blob a
request created is released once the route has answered.

```json
"codecs": { "application/json": "@http/codecs/json.codec.json", "text/csv": "@http/codecs/blob.codec.json" }
```

A route answers a report in three ways. An answer takes the status `response.status` chooses: `default`, or
`from` a path into the answer through `map`. A refusal -- a graph ending on purpose at `@std/outcome.port.json#refuse`,
a policy denying, the guard refusing a credential -- is answered as `{ "reason", "message" }` plus whatever the
refusal carries (a challenge's id and how to answer it) with the status `response.refusals` maps its reason
to; the trigger kind declares that map as where reasons are answered, so `wilanis check` requires every reason
the route can reach to be mapped (T005) and nothing mapped that it cannot reach (T006). A fault (a node that
broke) is a 500.

```json
"settings": { "route": "/tasks/{id}", "method": "GET",
  "response": { "refusals": { "missing": 404, "upstream": 502, "anonymous": 401, "forbidden": 403 } } }
```

The request's cookies are in the context as `request.cookies`, so a policy attachment may read a token from one. An
answer sets cookies through `response.cookies`: each names the field of the answer it takes (`from`), or
`clear` to drop it, and `omit` keeps the field out of the body once the cookie has it. HttpOnly and
SameSite=Lax unless said otherwise.

```json
"response": { "cookies": { "session": { "from": "accessToken", "httpOnly": true, "maxAge": 900 } } }
```

A connection may pace the requests made against it with `throttle`: `concurrency` is the most in flight at
once, `perSecond` the most started in any one second. Every node that names the connection shares the one
gate, so a `map` that fans out one request per element is held to it; a request past the limit waits, nothing
is dropped. The `check` hook refuses (X003) a throttle that could let nothing through.

```json
{ "kind": "@http/http.connection-kind.json",
  "settings": { "baseUrl": "https://api.example/v1", "throttle": { "concurrency": 4, "perSecond": 10 } } }
```

A route may bound how long its run takes and how much its body weighs: `deadlineMs` and `maxBodyBytes`, in the
route's settings or in the plugin's, where they hold for every route that writes none of its own. The route's
own is its limit; with neither there is none. The deadline counts from the moment the route fires, after the
body is read and judged: past it the run is cancelled (nothing more starts, what is in flight is told through
its signal) and the route answers `504 { "error": "cancelled: the deadline passed" }` once the run has settled,
whatever had settled before. A body past its bound is answered 413 before any codec has finished with it: a
JSON body is not parsed, an upload is not stored past the cut. A connection's `maxBodyBytes` bounds an answer
from the upstream the same way, and a request past it fails its node as a fault. The `check` hook refuses
(X004) a limit that is not a whole number of 1 or more.

```json
{ "use": "@http", "from": "@wilanis/plugin-http",
  "settings": { "port": 8080, "deadlineMs": 30000, "maxBodyBytes": 1048576,
    "codecs": { "application/json": "@http/codecs/json.codec.json" } } }
```

Depends on `@wilanis/core` and `@wilanis/engine`.

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
