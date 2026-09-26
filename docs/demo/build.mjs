#!/usr/bin/env node
// Run the demo of docs/demo.md against a fresh copy of the example, assert the
// payoff of every step, and only then write docs/demo/index.html from what the
// run printed. A failed assertion exits 1 naming the step and its actual output.
//
//   npm run build && node docs/demo/build.mjs [scratch-dir]
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, DOCUMENTS, IR, LOCAL_STARTUP_STEPS, REGISTRATION } from "./lib/expected.mjs";
import { render } from "./lib/render.mjs";
import { Server, call, resetCopy, signIn, wilanis } from "./lib/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const scratch = process.argv[2] ?? join(tmpdir().replace(/\/$/, ""), "wilanis-demo");
const ROUTE = "features/customers/edge/archive-customer.trigger.json";
const INVARIANTS = [
  "features/customers/domain/writes-are-for-registrars.invariant.json",
  "features/customers/domain/a-customer-is-reachable.invariant.json",
];

class Failed extends Error {
  constructor(step, what, actual) {
    super(`${step}: ${what}`);
    this.actual = actual;
  }
}

/** Fail the build unless `condition` holds, naming the step and printing what it actually got. */
function assert(step, condition, actual, what = "assertion") {
  if (!condition) throw new Failed(step, what, actual);
}

const codesOf = (text) => [...text.matchAll(/^([A-Z]\d{3})\s/gm)].map((m) => m[1]);
const read = (ctx, rel) => readFileSync(join(ctx.scratch, rel), "utf8").replace(/\n$/, "");
const paste = (ctx, name) => copyFileSync(join(here, name), join(ctx.scratch, ROUTE));
const check = (ctx) => wilanis(ctx, "check", ".").text;
const CHECK = { text: "Then the whole tree is judged.", pre: "npx wilanis check ." };

function step0(ctx) {
  const title = "The tree and its two rules";
  const out = check(ctx);
  const want = `ok: ${DOCUMENTS.shipped} documents, ${IR}`;
  assert(title, out === want, out, `check answers ${want}`);
  return {
    number: 0,
    title,
    summary: out,
    does: [{ text: "Nothing yet. The tree is the example as it ships, and it is judged before anyone touches it.", pre: "npx wilanis check ." }],
    answers: [{ pre: out }],
    why: `Every one of the ${DOCUMENTS.shipped} is a JSON document and none is code, so there is nothing an agent can write that the checker does not read whole. The two sentences above are the rules a human wrote; step 1 is where the first is caught, step 7 the second. Neither is repeated anywhere else in the tree.`,
  };
}

function step1(ctx) {
  const title = "The agent scaffolds a route";
  const made = wilanis(ctx, "new", "trigger", "features/customers/edge/archive-customer", ".", "--run", "@customers/domain/customer.port.json#remove", "--kind", "@http/http.trigger-kind.json").text;
  const out = check(ctx);
  const want = CODES.scaffolded;
  const count = `${want.length} refusal(s)`;
  assert(title, codesOf(out).join(" ") === want.join(" ") && out.endsWith(count), out, `check answers ${want.join(", ")} and ${count}`);
  return {
    number: 1,
    title,
    summary: `${codesOf(out).join(" ")}, ${count}`,
    does: [
      { text: "The task is one line: add a way to archive a customer. The agent finds the <code>remove</code> operation on the customer port and scaffolds a route that fires it.", pre: `npx wilanis new trigger features/customers/edge/archive-customer . \\\n  --run '@customers/domain/customer.port.json#remove' --kind '@http/http.trigger-kind.json'\n${made}` },
      { text: `What it wrote, <code>${ROUTE}</code>:`, pre: read(ctx, ROUTE) },
      CHECK,
    ],
    answers: [{ pre: out, codes: true }],
    why: "The agent never read the invariant, and the refusal does not need it to: I001 names the file the agent wrote a second ago, the rule it broke by its label, the file the rule lives in, and two edits, either of which would fix it. Each refusal has a code that is stable, a path inside the file (<code>#policies</code>, <code>#settings/response/refusals</code>) and a hint that is an edit, which is the whole of what an agent's loop needs: write, check, edit.",
  };
}

function step2(ctx) {
  const title = "The agent follows the hints";
  paste(ctx, "archive-customer.step2.trigger.json");
  const out = check(ctx);
  const want = CODES.hinted;
  const count = `${want.length} refusal(s)`;
  assert(title, codesOf(out).join(" ") === want.join(" ") && out.endsWith(count), out, `check answers ${want.join(", ")} and ${count}`);
  return {
    number: 2,
    title,
    summary: `${want.join(" ")}, ${count}`,
    does: [
      { text: "Five of the eight hints are shape and status: the agent declares what the route takes and answers and maps the three reasons the operation can end with. It leaves the policy alone, since nothing yet told it why.", pre: read(ctx, ROUTE) },
      CHECK,
    ],
    answers: [{ pre: out, codes: true }],
    why: "One round of edits took five refusals to zero and touched nothing else, because each hint said where and what. What remains is not about the route's shape but about who may call it: I001, a rule of the tree, says the same thing it said before, since the rule did not move; and the two A006, one per profile that listens and keeps a store, say the customer stores keep each tenant's rows apart, so the route needs a policy that proves the caller's session carries a tenant. All three point at <code>#policies</code>.",
  };
}

function step3(ctx) {
  const title = "The agent does what the hint says, and no more";
  const file = join(ctx.scratch, ROUTE);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const edited = {};
  for (const [k, v] of Object.entries(doc)) {
    edited[k] = v;
    if (k === "out") edited.policies = ["@access/edge/can-register.policy.json"];
  }
  writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
  const out = check(ctx);
  const want = CODES.gated;
  const count = `${want.length} refusal(s)`;
  assert(title, codesOf(out).join(" ") === want.join(" ") && out.endsWith(count), out, `check answers ${want.join(", ")} and ${count}`);
  return {
    number: 3,
    title,
    summary: `${want.join(" ")}, ${count}`,
    does: [
      { text: "The I001 hint said: attach <code>\"@access/edge/can-register.policy.json\"</code> under <code>policies</code>. The agent adds exactly that line.", pre: read(ctx, ROUTE) },
      CHECK,
    ],
    answers: [{ pre: out, codes: true }],
    why: "Fixing one refusal surfaced three the agent could not have seen: the policy reads who is calling, and nothing on this route hands the guard a token to find out (A005, with the JSON to paste); and a gated route can now end <code>forbidden</code> or <code>anonymous</code>, which the route must map (T005). A rule catching a route is not one refusal but a conversation, and every turn of it is an edit the agent can make without reading a manual.",
  };
}

function step4(ctx) {
  const title = "The finished route";
  paste(ctx, "archive-customer.step3.trigger.json");
  const out = check(ctx);
  const want = `ok: ${DOCUMENTS.finished} documents, ${IR}`;
  assert(title, out === want, out, `check answers ${want}`);
  return {
    number: 4,
    title,
    summary: out,
    does: [{ text: "The policy given the token as the hint wrote it, and 403, 401, 401 for <code>forbidden</code>, <code>anonymous</code> and <code>invalid_credential</code>.", pre: read(ctx, ROUTE) }, CHECK],
    answers: [{ pre: out }],
    why: "Three rounds, and the tree checks. The agent phrased the route its own way, and the invariant is the one sentence it could not talk its way past: however the route was written, it reached <code>remove</code>, and every way to <code>remove</code> is gated or refused. The human wrote that sentence once; the agent met it without ever opening the file.",
  };
}

function step5(ctx) {
  const title = "Tests nobody wrote";
  const reh = wilanis(ctx, "rehearse", ".", "--profile", "local").text;
  const block = reh.match(/^features\/access\/domain\/require-registrar {2}switch 'isRegistrar' {2}3\/3 branches\n(?: .*\n?){3}/m)?.[0]?.trimEnd();
  const summary = reh.slice(reh.indexOf("every branch settled")).trimEnd();
  assert(title, Boolean(block) && summary.includes("Writes are for registrars  holds at 7 trigger(s)"), reh, "rehearse shows require-registrar 3/3 branches and Writes are for registrars holds at 7 trigger(s)");
  const map = wilanis(ctx, "map", ".", "--profile", "local").text;
  const mapBlock = map.match(/^@features\/customers\/edge\/archive-customer\.trigger\.json.*\n(?:[ \t].*\n?)*/m)?.[0]?.trimEnd();
  assert(title, Boolean(mapBlock) && mapBlock.includes("holds  @features/customers/domain/writes-are-for-registrars.invariant.json"), map, "map's archive-customer block holds the invariant");
  return {
    number: 5,
    title,
    summary: "require-registrar 3/3 branches; holds at 7 trigger(s); map holds the invariant",
    does: [
      { text: "No test was written for the route. The rehearsal runs every route, every policy and every branch of every switch with the effects stubbed.", pre: "npx wilanis rehearse . --profile local" },
      { text: "Then the map: how a request flows, and what gates it.", pre: "npx wilanis map . --profile local" },
    ],
    answers: [
      { pre: `${block}\n\n${summary}`, full: reh, label: "the whole rehearsal" },
      { pre: mapBlock, full: map, label: "the whole map" },
    ],
    why: "This is the test suite the agent did not write. The three branches of the registrar decision each ran to a declared outcome, and the summary counts the new route among the seven the invariant holds at, up from six before the agent began. The map says in one line what step 1 said as a refusal: the route holds the invariant, through the policy.",
    note: "<code>map</code> today prints the graphs of all three bindings under <code>#remove</code> and <code>??</code> lines under nested domain calls although a profile was given (#481), and ends with 17 <code>orphan</code> lines for graphs the tree does reach (#488). Both are shown as printed.",
  };
}

async function step6(ctx) {
  const title = "Live";
  ctx.server = new Server(ctx, join(ctx.scratch, "node_modules", ".bin", "wilanis"), ["start", ".", "--profile", "local"]);
  await ctx.server.waitFor(new RegExp(`startup ${LOCAL_STARTUP_STEPS}/${LOCAL_STARTUP_STEPS} Listen: ok`), 30_000);
  const anon = await call("POST", "/customers/x/archive");
  assert(title, anon.status === 401 && anon.json?.reason === "anonymous", `${anon.status} ${anon.text}`, "no token answers 401 anonymous");
  const cy = await call("POST", "/customers/x/archive", { token: await signIn("cy", "cy-pass") });
  assert(title, cy.status === 403 && cy.json?.reason === "forbidden", `${cy.status} ${cy.text}`, "cy answers 403 forbidden");
  ctx.bo = await signIn("bo", "bo-pass");
  const made = await call("POST", "/customers", { token: ctx.bo, type: "application/json", body: REGISTRATION });
  assert(title, made.status === 201 && made.json?.id, `${made.status} ${made.text}`, "bo registers a customer, 201");
  const gone = await call("POST", `/customers/${made.json.id}/archive`, { token: ctx.bo });
  assert(title, gone.status === 200 && gone.json?.id === made.json.id, `${gone.status} ${gone.text}`, "bo archives it, 200 with the same id");
  const forbiddenLine = ctx.steps[5].answers[0].pre.split("\n").find((l) => l.includes("as forbidden:"));
  const signin = (who) => `TOKEN=$(curl -s -X POST localhost:8099/api/v1/auth-employees -H 'content-type: application/json' \\\n  -d '{"username":"${who}","password":"${who}-pass"}' | sed -n 's/.*"accessToken":"\\([^"]*\\)".*/\\1/p')`;
  return {
    number: 6,
    title,
    summary: `${anon.status} anonymous, ${cy.status} forbidden, ${made.status} registered, ${gone.status} archived`,
    does: [
      { text: "Serve it. The key the tree signs its tokens with is the one secret it reads from the environment, and the only thing this run needed from outside the tree.", pre: "npm run start -- --profile local" },
      { text: "No token:", pre: "curl -s -X POST localhost:8099/customers/x/archive" },
      { text: "As cy, who holds the <code>viewer</code> group and not <code>registrar</code>:", pre: `${signin("cy")}\ncurl -s -X POST localhost:8099/customers/x/archive -H "authorization: Bearer $TOKEN"` },
      { text: "As bo, a registrar: register a customer, then archive them.", pre: `${signin("bo")}\ncurl -s -X POST localhost:8099/customers -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\\n  -d '${REGISTRATION}'\ncurl -s -X POST localhost:8099/customers/$ID/archive -H "authorization: Bearer $TOKEN"` },
    ],
    answers: [
      { pre: `${anon.status}  ${anon.text}` },
      { text: "As cy, beside the rehearsal's <code>forbidden</code> line from step 5:", pre: `${cy.status}  ${cy.text}\n${forbiddenLine}` },
      { pre: `${made.status}  ${made.text}\n${gone.status}  ${gone.text}` },
    ],
    why: "The 403 and the rehearsal line are the same branch and the same sentence: the rehearsal ran it with the effects stubbed before the server was up, the route mapped the reason to a status in step 4, and the guard, the policy and the graph did the rest. The route the agent wrote never saw the token; the guard verified it before any graph ran. No document validates a token and no graph checks access, so there is nothing of that kind an agent can get wrong.",
  };
}

async function step7(ctx) {
  const title = "All of it or none of it";
  const csv = readFileSync(join(here, "customers.bad.csv"), "utf8");
  const imp = await call("POST", "/customers.csv", { token: ctx.bo, type: "text/csv", body: csv });
  assert(title, imp.status === 500 && imp.json?.reason === "invariant" && imp.json.message.includes("A customer is reachable"), `${imp.status} ${imp.text}`, "the import answers 500 invariant naming A customer is reachable");
  const list = await call("GET", "/customers", { token: ctx.bo });
  assert(title, list.text === "[]", `${list.status} ${list.text}`, "GET /customers as bo answers []");
  const atomic = read(ctx, "features/customers/domain/register-all.graph.json").split("\n").find((l) => l.includes('"atomic"'));
  assert(title, Boolean(atomic), "no atomic line", "register-all.graph.json has an atomic line");
  return {
    number: 7,
    title,
    summary: `${imp.status} invariant, then []`,
    does: [
      { text: "A file of five customers whose fifth row is not a customer: the address is empty.", pre: csv.trimEnd() },
      { text: "Import it as bo, then list.", pre: `curl -s -X POST localhost:8099/customers.csv -H 'content-type: text/csv' -H "authorization: Bearer $TOKEN" \\\n  --data-binary @customers.bad.csv\ncurl -s localhost:8099/customers -H "authorization: Bearer $TOKEN"` },
    ],
    answers: [
      { pre: `${imp.status}  ${imp.text}\n${list.status}  ${list.text}` },
      { text: "The line in <code>features/customers/domain/register-all.graph.json</code> that made it so:", pre: atomic.trim() },
    ],
    why: "Four good rows went in before the fifth refused, and bo's tenant holds none of them. The 500 carries the second rule in its own words, and nobody wrote that message. The graph says one word, <code>atomic</code>, and the compiler refused to accept it anywhere the effects could not be one transaction, so the word is checked rather than trusted. An agent that writes a graph with that word gets the promise or a refusal, never a half-written store.",
  };
}

async function step8(ctx) {
  const title = "An edit that never reaches the serving tree";
  paste(ctx, "archive-customer.step2.trigger.json");
  const refused = await ctx.server.waitFor(/reload refused, still serving the last good tree:\n(?:.*\n)*?.*I001.*\n(?: .*\n?){2}/, 15_000);
  assert(title, refused.includes("I001"), refused, "the reload is refused with I001");
  const anon = await call("POST", "/customers/x/archive");
  assert(title, anon.status === 401, `${anon.status} ${anon.text}`, "the route still answers 401");
  paste(ctx, "archive-customer.step3.trigger.json");
  const served = await ctx.server.waitFor(new RegExp(`reload: ${DOCUMENTS.finished} documents, serving the new tree`), 15_000);
  const how = await ctx.server.stop();
  assert(title, how.code !== null || how.signal === "SIGTERM", JSON.stringify(how), "the server exits on SIGTERM");
  return {
    number: 8,
    title,
    summary: `reload refused with I001, still 401; ${served}; exited`,
    does: [
      { text: "With the server still running, the agent puts the step 2 file back over the route: the one without the policy.", pre: `cp archive-customer.step2.trigger.json ${ROUTE}` },
      { text: "Then, with the finished file back in place:", pre: `cp archive-customer.step3.trigger.json ${ROUTE}` },
    ],
    answers: [
      { text: "The server's log, and the route while the bad file sat on disk:", pre: `${refused.trimEnd()}\n\n${anon.status}  ${anon.text}`, codes: true },
      { pre: served },
    ],
    why: "The edit never reached the serving tree. A document that does not pass <code>wilanis check</code> is reported in the log with the same code and hint the agent saw in step 1, and the last good tree keeps answering, so an agent editing a tree that is live cannot make the write public for even one request. The check that judged the file at rest is the one that guards it while it serves.",
  };
}

async function main() {
  const env = resetCopy(repo, scratch);
  const ctx = { scratch, env, steps: [] };
  console.log(`copied the example to ${scratch}`);
  const runners = [step0, step1, step2, step3, step4, step5, step6, step7, step8];
  try {
    for (const run of runners) {
      const step = await run(ctx);
      ctx.steps.push(step);
      console.log(`ok  ${step.number}  ${step.title} -- ${step.summary}`);
    }
  } catch (e) {
    await ctx.server?.stop();
    if (e instanceof Failed) {
      console.error(`FAIL  ${e.message}\n${e.actual}`);
      process.exit(1);
    }
    throw e;
  }
  const meta = {
    date: new Date().toISOString().slice(0, 10),
    commit: execSync("git rev-parse --short HEAD", { cwd: repo, encoding: "utf8" }).trim(),
    scratch,
  };
  const invariants = INVARIANTS.map((path, i) => ({ path, text: read(ctx, path), step: i === 0 ? 1 : 7 }));
  const page = render({ steps: ctx.steps, invariants, meta });
  writeFileSync(join(here, "index.html"), page);
  console.log(`wrote docs/demo/index.html (${(page.length / 1024).toFixed(1)} KB) from ${meta.commit}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
