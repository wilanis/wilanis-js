// What the demo's beats answer, said once. build.mjs asserts its run against these, and
// packages/runtime/test/demo-script.test.ts holds the tree and docs/demo.md to the same values, so a change
// to the example that moves a count fails the tests until the script says the new one.

/** `wilanis check .` on the example as it ships, and once the finished route is pasted: `ok: N documents, IR`. */
export const DOCUMENTS = { shipped: 221, finished: 222 };

/** What `wilanis check .` says after the count: the tree's IR version and the one the runtime reads (RFC 0008). */
export const IR = "IR v1, runtime reads v1";

/** The codes `wilanis check .` answers at each turn of beats 2 and 3, in the order it prints them. */
export const CODES = {
  scaffolded: ["T002", "T002", "A006", "A006", "A006", "A006", "T005", "T005", "T005", "I001"],
  hinted: ["A006", "A006", "A006", "A006", "I001"],
  gated: ["A005", "T005", "T005"],
};

/** How many startup steps `wilanis start . --profile local` runs; the last is Listen: `startup N/N Listen: ok`. */
export const LOCAL_STARTUP_STEPS = 9;

/** The customer bo registers in beat 6, as the body `curl` sends. */
export const REGISTRATION = '{"name":"Ada Lovelace","email":"ada@example.com","tier":"bronze"}';
