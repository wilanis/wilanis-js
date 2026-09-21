// What build.mjs needs to run the demo: a scratch copy of the example, a command
// run to completion, a server run as a child whose log can be waited on, and
// an HTTP call. Node builtins only.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Copy the example to `scratch`, link the repository's node_modules, and answer the env the tree needs. */
export function resetCopy(repo, scratch) {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  cpSync(join(repo, "example"), scratch, { recursive: true });
  rmSync(join(scratch, "node_modules"), { recursive: true, force: true });
  rmSync(join(scratch, ".wilanis"), { recursive: true, force: true });
  symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"));
  return {
    ...process.env,
    MONITOR_JWT_SECRET: randomBytes(32).toString("base64"),
    // until #304 lands, start reads every profile's secrets although local never reaches PostgreSQL
    MONITOR_DATABASE_URL: "postgres://unused",
  };
}

/** Run a command in the copy to completion; answer what it printed and its exit status. */
export function sh(ctx, bin, args) {
  const r = spawnSync(bin, args, { cwd: ctx.scratch, env: ctx.env, encoding: "utf8" });
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  return { status: r.status, text: text.replace(/\n$/, "") };
}

/** Run `wilanis` from the copy's node_modules, as `npx wilanis` would. */
export function wilanis(ctx, ...args) {
  return sh(ctx, join(ctx.scratch, "node_modules", ".bin", "wilanis"), args);
}

/** A child process whose stdout and stderr are kept, and can be waited on line by line. */
export class Server {
  constructor(ctx, bin, args) {
    this.log = "";
    this.cursor = 0;
    this.waiters = [];
    this.exited = new Promise((resolve) => {
      this.child = spawn(bin, args, { cwd: ctx.scratch, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] });
      const take = (chunk) => {
        this.log += chunk.toString();
        this.#wake();
      };
      this.child.stdout.on("data", take);
      this.child.stderr.on("data", take);
      this.child.on("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  #wake() {
    for (const w of [...this.waiters]) {
      const m = w.re.exec(this.log.slice(this.cursor));
      if (m) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        this.cursor += m.index + m[0].length;
        w.resolve(m[0]);
      }
    }
  }

  /** Wait for `re` to match the log past what earlier waits consumed; answer the match, or fail after `ms`. */
  waitFor(re, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`nothing matching ${re} in ${ms}ms; the log so far:\n${this.log}`));
      }, ms);
      this.waiters.push({
        re,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.#wake();
    });
  }

  /** Stop the child with SIGTERM and answer how it exited; SIGKILL after `ms`. */
  async stop(ms = 10_000) {
    this.child.kill("SIGTERM");
    const killer = setTimeout(() => this.child.kill("SIGKILL"), ms);
    const how = await this.exited;
    clearTimeout(killer);
    return how;
  }
}

/** One HTTP call against the served tree; answer the status, the body text and the body parsed where it is JSON. */
export async function call(method, path, { token, body, type } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (type) headers["content-type"] = type;
  const r = await fetch(`http://127.0.0.1:8099${path}`, { method, headers, body });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}

/** Sign in as an employee and answer the access token. */
export async function signIn(username, password) {
  const r = await call("POST", "/api/v1/auth-employees", {
    type: "application/json",
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200 || !r.json?.accessToken) throw new Error(`sign-in as ${username} answered ${r.status}: ${r.text}`);
  return r.json.accessToken;
}
