import assert from "node:assert/strict"
import test from "node:test"
import { GoalPlugin } from "../src/goal-plugin.js"

test("built-in auditor honors SDK shape for creation, prompt, abort and cleanup", async (t) => {
  for (const sdkShape of ["flat", "legacy"]) {
    for (const timeout of [false, true]) {
      await t.test(`${sdkShape}, ${timeout ? "timeout" : "approval"}`, async () => {
        const calls = []
        const body = input => sdkShape === "flat" ? input : input.body
        const sessionID = input => sdkShape === "flat" ? input.sessionID : input.path.id
        const client = { session: {
          create: async input => { calls.push(["create", input]); return { data: { id: "child", parentID: body(input).parentID } } },
          prompt: async input => { calls.push(["prompt", input]); assert.equal(sessionID(input), "child"); return timeout ? new Promise(() => {}) : { data: { parts: [{ type: "text", text: "[audit:approved]" }] } } },
          abort: async input => { calls.push(["abort", input]); assert.equal(sessionID(input), "child"); return {} },
          delete: async input => { calls.push(["delete", input]); assert.equal(sessionID(input), "child"); return {} },
        } }
        const hooks = await GoalPlugin({ client }, { sdkShape, completionAudit: true, auditorOptions: { timeoutMs: 10 }, persistState: false, auditMessages: false, lifecycleMessages: false })
        try {
          await hooks.config({})
          const context = { sessionID: "parent", agent: "build" }
          await hooks.tool.goal_set.execute({ objective: "completed" }, context)
          const result = JSON.parse(await hooks.tool.goal_complete.execute({ summary: "done" }, context))
          assert.equal(result.ok, !timeout)
          assert.deepEqual(calls.map(([name]) => name), timeout ? ["create", "prompt", "abort", "delete"] : ["create", "prompt", "delete"])
          assert.equal(body(calls[1][1]).agent, "goal-verify")
          if (sdkShape === "flat") assert.ok(calls.every(([, input]) => !("body" in input) && !("path" in input)))
        } finally { await hooks.dispose() }
      })
    }
  }
})
