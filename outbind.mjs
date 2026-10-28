#!/usr/bin/env node
/**
 * outbind: Obi's brain from the terminal. Talks to Outbind's brain API (/api/v1/brain) with the same sign-in or
 * AI assistant key as Outbind's MCP server, so it can do what the MCP server lets an AI assistant do, capped at
 * drafting and editing: no lead finding, enrichment, sending or turning anything on.
 *
 * No dependencies: Node 20+ only (fetch, FormData, Blob are built in).
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { existsSync } from "node:fs";

const VERSION = "0.1.0";
const DEFAULT_URL = "https://app.outbind.ai";
const FILE_TYPES = new Set([".pdf", ".docx", ".pptx", ".txt", ".md", ".csv"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const HELP = `outbind ${VERSION}: Obi's brain from the terminal

No account yet? Run outbind signup you@company.com, or sign up at https://app.outbind.ai/sign-up.

Usage
  outbind learn <website>       Turn any company's website into brain.md (no account needed)
  outbind learn <website> --out FILE   Save it somewhere else (default brain.md)

  outbind signup <email>        Make an Outbind account: we email a code, you type it here
  outbind signup <email> --code 123456 --name "Jane Doe" --company Acme
                                Step two without questions, once the code is in (for agents and scripts)
  outbind login                 Sign in with your browser (recommended)
  outbind login --key ob_…      Or use an AI assistant key from Settings → MCP
  outbind logout                Forget the sign-in on this computer
  outbind whoami                Your workspace, access and tools

  outbind docs                  Documents Obi learned from
  outbind docs add <file>…      Teach Obi from PDF, Word, PowerPoint, text, Markdown or CSV (10 MB each)
  outbind docs add - --name N   Teach Obi from text on stdin
  outbind docs remove <id>      Remove a document and what Obi learned from it

  outbind tools                 The brain tools you can run
  outbind run <tool> [k=v…]     Run one, e.g. outbind run search_leads query=dentist limit=5
  outbind run <tool> --json '{…}'   Or pass the arguments as JSON (- reads them from stdin)

  outbind mcp                   How to add Outbind to Claude, Claude Code, Cursor or ChatGPT

Options
  --url <url>      Another Outbind (default ${DEFAULT_URL}, or OUTBIND_URL)
  --raw            Compact JSON output, for scripts
  OUTBIND_API_KEY  Use this key instead of the saved sign-in

Docs: https://app.outbind.ai/settings/mcp`;

// ---------- arguments ----------

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (["raw", "help", "version", "force"].includes(k)) flags[k] = true;
      else flags[k] = argv[++i] ?? "";
    } else if (a === "-h") flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

class CliError extends Error {}
const fail = (msg) => {
  throw new CliError(msg);
};

// ---------- saved sign-in ----------

const configPath = () => join(process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming") : join(homedir(), ".config")), "outbind", "config.json");

async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath(), "utf8"));
  } catch {
    return {};
  }
}

/** Saved readable only by this user: it holds a key or tokens that act as the person. */
async function saveConfig(cfg) {
  const p = configPath();
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  await writeFile(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await chmod(p, 0o600).catch(() => {});
}

const baseUrl = (flags, cfg) => (flags.url || process.env.OUTBIND_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, "");

/** The bearer to send: OUTBIND_API_KEY, the saved key, or the saved sign-in (refreshed when it's about to run out). */
async function bearer(flags) {
  if (process.env.OUTBIND_API_KEY) return process.env.OUTBIND_API_KEY.trim();
  const cfg = await loadConfig();
  if (cfg.key) return cfg.key;
  if (!cfg.oauth) fail("Not signed in. Run: outbind login (no account yet? Run: outbind signup you@company.com)");
  if (cfg.oauth.expires_at - 60_000 > Date.now()) return cfg.oauth.access_token;
  const url = baseUrl(flags, cfg);
  const res = await fetch(`${url}/api/mcp-oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cfg.oauth.refresh_token, client_id: cfg.oauth.client_id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) fail(`Your sign-in has ended (${body.error_description || body.error || res.status}). Run: outbind login`);
  cfg.oauth = { ...cfg.oauth, access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + body.expires_in * 1000 };
  await saveConfig(cfg);
  return cfg.oauth.access_token;
}

// ---------- the brain API ----------

async function api(flags, method, path, body) {
  const cfg = await loadConfig();
  const headers = { authorization: `Bearer ${await bearer(flags)}`, "user-agent": `outbind-cli/${VERSION}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${baseUrl(flags, cfg)}/api/v1/brain${path}`, { method, headers, body: payload });
  } catch (err) {
    fail(`Couldn't reach Outbind: ${err.cause?.message || err.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    fail(`Outbind answered ${res.status} with something that isn't JSON.`);
  }
  if (!res.ok) {
    const e = json.error || {};
    const extra = e.fields ? ` ${Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`).join("; ")}` : "";
    fail(res.status === 401 ? `${e.message || "Not signed in."} Run: outbind login` : `${e.message || `Outbind answered ${res.status}.`}${extra}`);
  }
  return json;
}

const print = (flags, value) => console.log(flags.raw ? JSON.stringify(value) : JSON.stringify(value, null, 2));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- login ----------

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The link is printed too.
  }
}

const b64url = (buf) => buf.toString("base64url");

/** OAuth 2.1 with PKCE, as Claude and ChatGPT "Connect" do: register, open the consent page, catch the code on localhost. */
async function oauthLogin(url) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  let resolveCode;
  let rejectCode;
  const got = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Outbind</title><body style="font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center"><h1 style="font-size:1.25rem">${ok ? "You're signed in" : "Sign-in didn't finish"}</h1><p>${ok ? "You can close this tab and go back to the terminal." : "Go back to the terminal and run outbind login again."}</p>`);
    if (ok) resolveCode(u.searchParams.get("code"));
    else rejectCode(new CliError(u.searchParams.get("error_description") || u.searchParams.get("error") || "Sign-in was cancelled."));
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(() => rejectCode(new CliError("Sign-in timed out after 5 minutes. Run outbind login again.")), 5 * 60_000);

  try {
    const reg = await fetch(`${url}/api/mcp-oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Outbind CLI", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    const client = await reg.json().catch(() => ({}));
    if (!reg.ok || !client.client_id) fail(`Couldn't start sign-in: ${client.error_description || client.error || reg.status}`);

    const auth = new URL(`${url}/mcp/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, scope: "mcp:read mcp:write", resource: `${url}/api/mcp` })) auth.searchParams.set(k, v);
    console.error(`Opening your browser to sign in to Outbind. If it doesn't open, go to:\n\n  ${auth}\n`);
    openBrowser(auth.toString());

    const code = await got;
    const tok = await fetch(`${url}/api/mcp-oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: `${url}/api/mcp` }),
    });
    const t = await tok.json().catch(() => ({}));
    if (!tok.ok || !t.access_token) fail(`Sign-in failed: ${t.error_description || t.error || tok.status}`);
    return { client_id: client.client_id, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

async function login(flags) {
  const cfg = await loadConfig();
  const url = baseUrl(flags, cfg);
  const key = typeof flags.key === "string" && flags.key ? flags.key.trim() : null;
  if (key && !key.startsWith("ob_")) fail("That isn't an Outbind key. Make an AI assistant key in Settings → MCP (it starts with ob_).");
  const next = key ? { url, key } : { url, oauth: await oauthLogin(url) };
  await saveConfig(next);
  try {
    const me = await api(flags, "GET", "");
    console.log(`Signed in to ${me.workspace.name} (${me.access_label}). Try: outbind docs add deck.pdf`);
  } catch (err) {
    await saveConfig(cfg);
    throw err;
  }
}

// ---------- sign-up ----------

/** POST to the agent sign-up routes (no key yet). Fails with Outbind's own message. */
async function signupCall(url, path, body) {
  let res;
  try {
    res = await fetch(`${url}/api/v1/signup${path}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": `outbind-cli/${VERSION}` }, body: JSON.stringify(body) });
  } catch (err) {
    fail(`Couldn't reach Outbind: ${err.cause?.message || err.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    const extra = e.fields ? ` ${Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`).join("; ")}` : "";
    fail(`${e.message || `Outbind answered ${res.status}.`}${extra}`);
  }
  return json;
}

/**
 * Makes an account (or signs in to one) with the code Outbind emails, and saves the "can draft and edit" key it
 * returns, like `outbind login --key`. With --code it only checks the code, so an agent can run it in two steps.
 */
async function signup(flags, [email]) {
  if (!email || !email.includes("@")) fail("Usage: outbind signup you@company.com");
  const cfg = await loadConfig();
  const url = baseUrl(flags, cfg);
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  let code = typeof flags.code === "string" ? flags.code : null;
  if (!code) {
    await signupCall(url, "", { email });
    if (!tty) return console.log(`We emailed a 6-digit code to ${email}. Run: outbind signup ${email} --code <code> --name "<your name>" --company "<company>"`);
    console.log(`We emailed a 6-digit code to ${email}.`);
  }
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const ask = async (q) => (rl ? (await rl.question(q)).trim() : "");
    code ||= await ask("Code: ");
    const name = typeof flags.name === "string" ? flags.name : await ask("Your name (skip if you have an account): ");
    const company = typeof flags.company === "string" ? flags.company : await ask("Company (skip if you have an account): ");
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const out = await signupCall(url, "/verify", { email, code, timezone, app: "outbind CLI", ...(name ? { name } : {}), ...(company ? { company } : {}) });
    await saveConfig({ url, key: out.key });
    console.log(`${out.new_account ? "Account made" : "Signed in"}: ${out.workspace.name}. The key is saved on this computer.\nNext: outbind run create_icp --json '{"website":"yourcompany.com"}'   or   outbind docs add deck.pdf`);
  } finally {
    rl?.close();
  }
}

// ---------- learn ----------

const MADE_BY = "Made with Obi's brain by Outbind";

/** Signed in on this computer (or a key in the environment), without failing or refreshing anything. */
async function signedIn() {
  if (process.env.OUTBIND_API_KEY) return true;
  const cfg = await loadConfig();
  return Boolean(cfg.key || cfg.oauth);
}

/**
 * Reads a company's website into a short brain.md. No account needed: that's the free preview (/api/v1/learn).
 * Signed in, the same file is also added to your Outbind brain as a document, so Obi writes from it.
 * The last line always says what to do next, for the person and for the agent running this.
 */
async function learn(flags, [website]) {
  if (!website) fail("Usage: outbind learn acme.com");
  const cfg = await loadConfig();
  const out = typeof flags.out === "string" && flags.out ? flags.out : "brain.md";
  if (existsSync(out) && !flags.force && !(await readFile(out, "utf8").catch(() => "")).includes(MADE_BY)) {
    fail(`${out} already exists and wasn't made by outbind. Pick another file with --out, or add --force.`);
  }
  let res;
  try {
    res = await fetch(`${baseUrl(flags, cfg)}/api/v1/learn`, { method: "POST", headers: { "content-type": "application/json", "user-agent": `outbind-cli/${VERSION}` }, body: JSON.stringify({ website }) });
  } catch (err) {
    fail(`Couldn't reach Outbind: ${err.cause?.message || err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error || {};
    fail(e.message || `Outbind answered ${res.status}.`);
  }
  await writeFile(out, body.markdown);

  let added = null;
  if (await signedIn()) {
    const host = new URL(body.website).hostname.replace(/^www\./, "");
    added = (await api(flags, "POST", "/tools/add_document", { name: `Website brain: ${host}`, text: body.markdown })).result.document;
  }
  if (flags.raw) return print(flags, { ...body, file: out, added_to_brain: added });

  const b = body.brain;
  console.log(`${b.company}: ${b.one_liner}\n`);
  console.log(`Sells to: ${b.sells_to}`);
  if (b.buyers.length) console.log(`Buyers:   ${b.buyers.map((x) => x.title).join(", ")}`);
  if (b.objections.length) console.log(`Objections to expect: ${b.objections.map((o) => `"${o.objection}"`).join(", ")}`);
  console.log(`\nSaved ${out}.`);
  if (added) console.log(`Added to your Outbind brain (${docLine(added)}). Obi writes from it now. Try: outbind run draft_email --help`);
  else console.log(`\nNext: ${body.next}`);
}

// ---------- commands ----------

/** k=v pairs into tool arguments: numbers, true/false, null, arrays and objects are read as JSON. */
function kvArgs(pairs) {
  const out = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) fail(`Pass arguments as name=value (got "${p}"), or use --json.`);
    const k = p.slice(0, i);
    const raw = p.slice(i + 1);
    let v = raw;
    if (/^(-?\d+(\.\d+)?|true|false|null|\[.*\]|\{.*\})$/s.test(raw)) {
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw;
      }
    }
    out[k] = v;
  }
  return out;
}

async function addFile(flags, path) {
  const ext = extname(path).toLowerCase();
  if (!FILE_TYPES.has(ext)) fail(`${basename(path)}: Obi reads PDF, Word, PowerPoint, text, Markdown or CSV files.`);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail(`Can't read ${path}.`);
  }
  if (bytes.length > MAX_FILE_BYTES) fail(`${basename(path)} is over 10 MB. Try a shorter one, or save it as a PDF.`);
  const form = new FormData();
  form.append("file", new Blob([bytes]), basename(path));
  return (await api(flags, "POST", "/documents", form)).document;
}

const docLine = (d) => `${d.id}  ${d.status === "learned" ? `learned ${d.facts.length} ${d.facts.length === 1 ? "fact" : "facts"}` : d.status === "reading" ? "reading…" : `failed: ${d.error ?? ""}`}  ${d.name}`;

async function docs(flags, [sub = "list", ...rest]) {
  if (sub === "list" || sub === "ls") {
    const { documents } = (await api(flags, "GET", "/documents")).result;
    if (flags.raw) return print(flags, documents);
    if (!documents.length) return console.log("No documents yet. Add one: outbind docs add deck.pdf");
    for (const d of documents) console.log(docLine(d));
    return;
  }
  if (sub === "add") {
    if (!rest.length) fail("Name a file to add, e.g. outbind docs add deck.pdf");
    for (const path of rest) {
      if (path === "-") {
        const text = await readStdin();
        const { result } = await api(flags, "POST", "/tools/add_document", { name: flags.name || "Notes", text });
        console.log(flags.raw ? JSON.stringify(result.document) : `${docLine(result.document)}\n${result.note}`);
        continue;
      }
      const d = await addFile(flags, path);
      console.log(flags.raw ? JSON.stringify(d) : docLine(d));
    }
    if (!flags.raw) console.log("Obi reads each one in about a minute. See what it learned: outbind docs");
    return;
  }
  if (sub === "remove" || sub === "rm") {
    if (!rest[0]) fail("Give the document's id (from outbind docs).");
    await api(flags, "DELETE", `/documents/${encodeURIComponent(rest[0])}`);
    return console.log("Removed. Obi no longer uses what it learned from it.");
  }
  fail(`Unknown docs command "${sub}". Use list, add or remove.`);
}

async function tools(flags) {
  const { tools } = await api(flags, "GET", "/tools");
  if (flags.raw) return print(flags, tools);
  const w = Math.max(...tools.map((t) => t.name.length));
  for (const t of tools) console.log(`${t.name.padEnd(w)}  ${t.title}`);
  console.log("\nRun one: outbind run <tool> name=value …   Its arguments: outbind run <tool> --help");
}

async function run(flags, [name, ...pairs]) {
  if (!name) fail("Name a tool, e.g. outbind run search_leads query=dentist. See: outbind tools");
  if (flags.help) {
    const t = (await api(flags, "GET", "/tools")).tools.find((x) => x.name === name);
    if (!t) fail(`Unknown tool: ${name}. See: outbind tools`);
    return console.log(`${t.name}: ${t.title}\n\n${t.description}\n\nArguments:\n${JSON.stringify(t.inputSchema.properties ?? {}, null, 2)}`);
  }
  let args;
  if (flags.json !== undefined) {
    const raw = flags.json === "-" ? await readStdin() : flags.json;
    try {
      args = JSON.parse(raw || "{}");
    } catch {
      fail("--json must be valid JSON.");
    }
  } else args = kvArgs(pairs);
  print(flags, (await api(flags, "POST", `/tools/${encodeURIComponent(name)}`, args)).result);
}

function mcp(flags) {
  const url = `${baseUrl(flags, {})}/api/mcp`;
  console.log(`Outbind's MCP server: ${url}

Claude (web or desktop): Settings → Connectors → Add custom connector → paste the URL → Connect.
Claude Code:            claude mcp add --transport http outbind ${url}   then /mcp → outbind → Authenticate
ChatGPT:                Settings → Connectors → Create → paste the URL, then sign in.
Cursor / VS Code:       add an http MCP server with that URL and sign in when asked.

Once connected, attach a document in Claude and say "add this to my Outbind brain".`);
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (flags.version || cmd === "version") return console.log(VERSION);
  if (!cmd || cmd === "help" || (flags.help && cmd !== "run")) return console.log(HELP);
  switch (cmd) {
    case "learn":
      return learn(flags, rest);
    case "signup":
    case "sign-up":
      return signup(flags, rest);
    case "login":
      return login(flags);
    case "logout":
      await rm(configPath(), { force: true });
      return console.log("Signed out on this computer. To end the connection everywhere, remove it in Settings → MCP.");
    case "whoami": {
      const me = await api(flags, "GET", "");
      if (flags.raw) return print(flags, me);
      return console.log(`${me.workspace.name} · ${me.role} · ${me.access_label}\n${me.tools.length} tools: ${me.tools.join(", ")}`);
    }
    case "docs":
    case "documents":
      return docs(flags, rest);
    case "tools":
      return tools(flags);
    case "run":
    case "tool":
      return run(flags, rest);
    case "mcp":
      return mcp(flags);
    default:
      fail(`Unknown command "${cmd}". See: outbind help`);
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? err.message : `Something went wrong: ${err?.message ?? err}`);
  process.exit(1);
});
