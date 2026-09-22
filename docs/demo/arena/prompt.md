This is an unsupervised run. Nobody will answer a question, so do not ask one: decide, act, and report what you decided and why.

You are working in a wilanis project at <arena>/<model>. It is a registry of customers: records with a name, an email address and a tier, kept in a store, served over HTTP with sign-in and policies. Everything in it is JSON documents; there is no code to write. Read its CLAUDE.md and README.md first; they say how the language works and what commands exist. Work only inside that directory. The wilanis packages under its node_modules are installed software: use them through the `wilanis` command (`npx wilanis ...` from inside the directory, or the npm scripts in package.json), do not read or change their sources.

## The task

Customers have an optional boolean field `active`. Add an operation that toggles it: calling it on a customer whose `active` is false or missing sets it to true, and calling it on a customer whose `active` is true sets it to false. Expose the operation as an HTTP endpoint on the running tree, and validate it with curl.

## The gate

`accept.sh` in the directory is the acceptance test, written by the reviewer. Your work is done when
`bash accept.sh <METHOD> '<ROUTE>'` (your endpoint's verb and route, the route with the literal `{id}`)
prints PASS for every criterion and ends with ACCEPTED. Read it before you start: every criterion says
what the endpoint must do. Do not edit it. Run it as often as you like.

## How to run and validate

- `npm run check` judges the whole tree. `npm run rehearse -- --profile local` runs every trigger and every branch with effects stubbed.
- The tree serves under the `local` profile, in memory, on port <port>. Start it in the background with:
  `CUSTOMERS_JWT_SECRET=arena-secret CUSTOMERS_DATABASE_URL=postgres://unused npm run start -- --profile local > /tmp/arena-<model>.log 2>&1 &`
  and read the log for `Listen: ok`. Stop it with `kill $(lsof -ti tcp:<port>)` when you are done, never with `pkill` or any kill by name, since other trees serve on this machine; make sure nothing you started is still running when you finish. Never leave the directory: no `cd` out of it, no command on a path outside it.
- The README says who can sign in and how (`bo`, `cy`, `ana`) and shows the curl calls for registering a customer and for signing in. Use `sed` rather than `jq` to pull a token out of a response; `jq` may not be installed.
- Validate with curl every behaviour you consider part of the operation, including what happens when the toggle should not go through, and paste the exact commands and responses in your report.

## The report

When finished, report in this order: what you added or changed, file by file; every decision you had to make that the task did not settle for you, what you chose and why; the full output of your final `bash accept.sh ...` run; the curl commands you ran beyond it and their exact responses; and anything you left undone.
