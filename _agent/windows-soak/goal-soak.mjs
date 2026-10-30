// Goal-loop soak for issue #81: real OpenCode 2 host, a deterministic local
// model, goals that auto-continue, complete through the auditor, and survive
// reloads, repeated until the time budget runs out.
// usage: node goal-soak.mjs <pluginSrcDir> <label> <minutes>
import { createServer } from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

const [srcDir, label, minutesArg = "40"] = process.argv.slice(2)
const DEADLINE = Date.now() + Number(minutesArg) * 60_000
const WIN = process.platform === "win32"
const runtimeRoot = process.env.OPENCODE_V2_RUNTIME_DIR
const { make } = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@opencode/client/dist/promise/client.js")))
const binary = process.env.OPENCODE_V2_BINARY || join(runtimeRoot, "node_modules", `@opencode/cli-${WIN ? "windows" : process.platform}-${process.arch}`, "bin", WIN ? "opencode.exe" : "opencode")
const source = resolve(srcDir, "goal-plugin.js")

const root = await fs.mkdtemp(join(tmpdir(), `goal-soak-${label}-`))
const project = join(root, "project")
for (const dir of [project, join(project, ".opencode", "plugins"), ...["home", "data", "config", "cache", "state"].map(x => join(root, x))]) await fs.mkdir(dir, { recursive: true })
await fs.writeFile(join(project, ".opencode", "plugins", "goal.js"), `
import plugin from ${JSON.stringify(pathToFileURL(source).href)}
import { promises as fsp, appendFileSync } from "node:fs"
const RATE = Number(process.env.INJECT_EPERM || 0)
if (RATE > 0 && !fsp.__goal81) {
  const real = fsp.rename.bind(fsp)
  fsp.rename = async (from, to) => {
    if (String(to).endsWith("state.json") && Math.random() < RATE) {
      appendFileSync(${JSON.stringify(join(root, "injected.log"))}, new Date().toISOString() + " " + to + "\\n")
      appendFileSync(${JSON.stringify(join(root, "injected-stacks.log"))}, new Date().toISOString() + " " + to + "\\n" + new Error("trace").stack.split("\\n").slice(2, 12).join("\\n") + "\\n---\\n")
      const e = new Error("EPERM: operation not permitted, rename (injected)"); e.code = "EPERM"; e.errno = -4048; e.syscall = "rename"; throw e
    }
    return real(from, to)
  }
  fsp.__goal81 = true
}
export default { ...plugin, async setup(ctx) {
  ctx.options = { completionAudit: true, auditMessages: false, lifecycleMessages: false, minDelayMs: 200, maxTurns: 8, noToolCallTurnsBeforePause: 0, noProgressTurnsBeforePause: 0, auditorOptions: { timeoutMs: 20000 } }
  return plugin.setup(ctx)
} }
`)

// Deterministic model: every work turn calls a tool through Code Mode; about one
// turn in four claims completion; auditor prompts are approved.
const counts = { requests: 0, audits: 0, completeCalls: 0, toolCalls: 0, text: 0 }
let rng = 81
const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648
const fixture = createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return }
  const body = JSON.parse(raw)
  counts.requests++
  const audit = body.messages.some(m => JSON.stringify(m.content).includes("independent completion auditor"))
  const last = body.messages[body.messages.length - 1]
  const hasExecute = body.tools?.some(t => t.function?.name === "execute")
  let delta, finish = "stop"
  if (audit) { counts.audits++; delta = { role: "assistant", content: "Checked the fixture evidence.\n[audit:approved]" } }
  else if (hasExecute && last?.role !== "tool") {
    const complete = rand() < 0.12
    complete ? counts.completeCalls++ : counts.toolCalls++
    const code = complete ? 'return await tools.goal_complete({ summary: "Soak fixture step verified" })' : "return { step: Date.now() }"
    delta = { role: "assistant", tool_calls: [{ index: 0, id: `call-${counts.requests}`, type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }] }
    finish = "tool_calls"
  } else { counts.text++; delta = { role: "assistant", content: "Step done; continuing." } }
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 50, completion_tokens: 200, total_tokens: 250 } }]) {
    res.write(`data: ${JSON.stringify({ id: `chat-${counts.requests}`, object: "chat.completion.chunk", created: 1, model: "test", ...chunk })}\n\n`)
  }
  res.end("data: [DONE]\n\n")
})
await new Promise(r => fixture.listen(0, "127.0.0.1", r))
await fs.writeFile(join(project, "opencode.json"), JSON.stringify({ model: "local-capture/test", provider: { "local-capture": { npm: "@ai-sdk/openai-compatible", name: "Local fixture", options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "test-only" }, models: { test: { name: "Local fixture" } } } } }))
const reserve = createServer()
await new Promise(r => reserve.listen(0, "127.0.0.1", r))
const port = reserve.address().port
await new Promise(r => reserve.close(r))
const env = { ...process.env, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_SERVER_PASSWORD: "local-test-only", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" }
delete env.BUN_BE_BUN
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
let log = ""
child.stdout.on("data", c => { log += c }); child.stderr.on("data", c => { log += c })
let exitInfo = null
child.on("exit", (code, signal) => { exitInfo = { code, signal, at: new Date().toISOString() }; console.log(JSON.stringify({ label, serviceExited: exitInfo })) })
const client = make({ baseUrl: `http://127.0.0.1:${port}`, headers: { "x-opencode-directory": project, authorization: "Basic " + Buffer.from("opencode:local-test-only").toString("base64") } })
const location = { directory: project }
const statePath = id => join(project, ".opencode", "goals", "state.json.sessions", createHash("sha256").update(id).digest("hex"), "state.json")
const readState = async id => { try { return JSON.parse(await fs.readFile(statePath(id), "utf8")) } catch { return null } }

const proc = () => {
  if (exitInfo) return { exited: exitInfo }
  try {
    if (WIN) {
      const [ws, handles] = execFileSync("powershell", ["-NoProfile", "-Command", `$p = Get-Process -Id ${child.pid}; "$($p.WorkingSet64) $($p.HandleCount)"`]).toString().trim().split(" ").map(Number)
      return { rssMb: Math.round(ws / 1048576), handles }
    }
    const rssKb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)]).toString().trim())
    const handles = execFileSync("lsof", ["-n", "-P", "-p", String(child.pid)]).toString().trim().split("\n").length - 1
    return { rssMb: Math.round(rssKb / 1024), handles }
  } catch (e) { return { probeError: String(e.message || e).slice(0, 200) } }
}
const outcomes = {}
const stuckGoals = []
const samples = []
let cycles = 0, reloads = 0, maxTurnSeen = 0, slowestCycleMs = 0, lastSample = 0
const sample = () => { const s = { t: Math.round((Date.now() - (DEADLINE - Number(minutesArg) * 60_000)) / 1000), cycles, reloads, ...proc(), ...counts, outcomes: { ...outcomes } }; samples.push(s); console.log(JSON.stringify(s)) }

try {
  for (let i = 0; i < 200; i++) { try { await client.server.info(); break } catch {} if (exitInfo) throw new Error(log); await new Promise(r => setTimeout(r, 100)) }
  await client.plugin.list({ location })
  sample()
  const transport = { errors: 0, first: [], consecutive: 0 }
  while (Date.now() < DEADLINE && !exitInfo) {
   try {
    cycles++
    const started = Date.now()
    const session = await client.session.create({ location, agent: "build", model: { providerID: "local-capture", id: "test" } })
    await client.session.command({ sessionID: session.id, name: "goal", text: `soak objective ${cycles}` })
    if (cycles % 5 === 0) { await new Promise(r => setTimeout(r, 1500)); await client.location.reload(); await client.plugin.list({ location }); reloads++ }
    let outcome = "timeout"
    while (Date.now() - started < Number(process.env.CYCLE_TIMEOUT_MS || 180_000) && !exitInfo) {
      await new Promise(r => setTimeout(r, 1000))
      const st = await readState(session.id)
      if (!st) continue
      const live = (st.goals || []).filter(g => !g.stopped)
      for (const g of st.goals || []) maxTurnSeen = Math.max(maxTurnSeen, g.turnCount || 0)
      if (!live.length && ((st.archives || []).length || (st.goals || []).length)) {
        outcome = (st.archives || []).length ? "completed" : `stopped: ${(st.goals || []).map(g => g.stopReason).join("|").replace(/\(.*\)/, "").trim()}`
        break
      }
    }
    const reloaded = cycles % 5 === 0
    const persistFailsBefore = (log.match(/Failed to persist/g) || []).length
    if (outcome === "timeout") {
      let convo = null, inbox = null, info = null
      try { convo = (await client.session.context({ sessionID: session.id })).slice(-6).map(m => ({ type: m.type || m.role, id: m.id, at: m.time?.created ? new Date(m.time.created).toISOString() : undefined, text: JSON.stringify(m.content ?? m.text ?? m.parts ?? m.prompt ?? "").slice(0, 140), tool: Array.isArray(m.content) ? m.content.filter(c => c.type === "tool").map(c => ({ name: c.name, status: c.state?.status, code: String(c.state?.input?.code || "").slice(0, 80), output: JSON.stringify(c.state?.output ?? c.state?.result ?? c.state?.error ?? "").slice(0, 700) })) : undefined })) } catch (e) { convo = String(e?.message || e).slice(0, 120) }
      try { inbox = await client.session.inbox.list({ sessionID: session.id }) } catch (e) { inbox = String(e?.message || e).slice(0, 120) }
      try { const i = await client.session.get({ sessionID: session.id }); info = { status: i.status, busy: i.busy, state: i.state } } catch (e) { info = String(e?.message || e).slice(0, 120) }
      const before = await readState(session.id)
      const g0 = (before?.goals || []).find(g => !g.stopped) || {}
      try { await client.session.command({ sessionID: session.id, name: "goal", text: "status" }) } catch {}
      await new Promise(r => setTimeout(r, 3000))
      const after = await readState(session.id)
      const g1 = (after?.goals || []).find(g => g.goalId === g0.goalId) || {}
      const stuck = { cycle: cycles, reloaded, persistFailuresSoFar: persistFailsBefore, injectedSoFar: await fs.readFile(join(root, "injected.log"), "utf8").then(t => t.split("\n").filter(Boolean).length).catch(() => 0),
        convo, inbox, info, lastContinueAt: g0.lastContinueAt ? new Date(g0.lastContinueAt).toISOString() : 0,
        disk: { turnCount: g0.turnCount, lastStatus: String(g0.lastStatus || "").slice(0, 160), claim: g0.continuationClaim ? "set" : null },
        afterPoke: { stopped: g1.stopped, stopReason: g1.stopReason, turnCount: g1.turnCount, lastStatus: String(g1.lastStatus || "").slice(0, 200) } }
      stuckGoals.push(stuck); console.log(JSON.stringify({ label, stuck }))
    }
    outcomes[outcome] = (outcomes[outcome] || 0) + 1
    slowestCycleMs = Math.max(slowestCycleMs, Date.now() - started)
    if (Date.now() - lastSample > 60_000) { lastSample = Date.now(); sample() }
    transport.consecutive = 0
   } catch (e) {
    transport.errors++; transport.consecutive++
    if (transport.first.length < 5) transport.first.push({ cycle: cycles, at: new Date().toISOString(), error: String(e?.message || e).slice(0, 200), cause: String(e?.cause?.code || e?.cause?.message || "").slice(0, 120), alive: !exitInfo })
    console.log(JSON.stringify({ label, transportError: transport.first.at(-1), total: transport.errors }))
    if (transport.consecutive >= 5) { console.log(JSON.stringify({ label, gaveUp: "5 consecutive request failures" })); break }
    await new Promise(r => setTimeout(r, 2000))
   }
  }
  counts.transportErrors = transport.errors
  sample()
  let goalWorks = false
  try {
    const s = await client.session.create({ location, agent: "build" })
    await client.session.command({ sessionID: s.id, name: "goal", text: "status" }); goalWorks = true
  } catch (e) { goalWorks = String(e?.message || e) }
  console.log(JSON.stringify({ label, root, alive: !exitInfo, goalWorks, persistFailures: (log.match(/Failed to persist/g) || []).length, stuck: stuckGoals.length, cycles, reloads, maxTurnSeen, slowestCycleMs, outcomes, counts }))
} catch (error) {
  console.error(JSON.stringify({ label, root, error: String(error?.stack || error), exitInfo, logTail: log.slice(-3000) }))
  process.exitCode = 1
} finally {
  child.kill("SIGTERM")
  await fs.writeFile(join(root, "server.log"), log)
  if (process.env.OUT_DIR) {
    await fs.mkdir(process.env.OUT_DIR, { recursive: true })
    await fs.writeFile(join(process.env.OUT_DIR, `${label}-soak-server.log`), log)
    await fs.writeFile(join(process.env.OUT_DIR, `${label}-soak-samples.json`), JSON.stringify(samples, null, 2))
    await fs.writeFile(join(process.env.OUT_DIR, `${label}-stuck.json`), JSON.stringify(stuckGoals, null, 2))
  }
  fixture.closeAllConnections(); fixture.close()
}
