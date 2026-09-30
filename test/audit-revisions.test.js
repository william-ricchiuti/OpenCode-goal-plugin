import assert from "node:assert/strict"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

const sessionID = "audit-revision"
const context = { sessionID, agent: "build" }

test("completion audits reject objective edits on both tool and marker paths", async (t) => {
  for (const completion of ["tool", "marker"]) {
    for (const edit of ["tool", "command"]) {
      await t.test(`${completion} completion, ${edit} edit`, async () => {
        let entered, resolveVerdict, snapshot
        const ready = new Promise(resolve => { entered = resolve })
        const verdict = new Promise(resolve => { resolveVerdict = resolve })
        const hooks = await GoalPlugin({ client: { session: {
          messages: async () => ({ data: [{ info: { id: "assistant", role: "assistant", sessionID }, parts: [{ type: "text", text: "[goal:evidence] original done\n[goal:complete]" }] }] }),
          promptAsync: async () => ({}),
        } } }, { persistState: false, auditMessages: false, lifecycleMessages: false,
          auditor: async ({ goal }) => { snapshot = goal; entered(); return verdict },
        })
        try {
          await hooks.tool.goal_set.execute({ objective: "original" }, context)
          const original = testInternals.currentGoal(sessionID)
          const budget = { startedAt: original.startedAt, turnCount: original.turnCount, totalTokens: original.totalTokens }
          const pending = completion === "tool"
            ? hooks.tool.goal_complete.execute({ summary: "original done" }, context)
            : hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
          await ready
          if (edit === "tool") await hooks.tool.update_goal.execute({ objective: "unfinished revision" }, context)
          else await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: "edit unfinished revision" }, { parts: [] })
          assert.equal(snapshot.condition, "original", "auditor must receive a stable snapshot")
          snapshot.condition = "auditor mutation"
          snapshot.options.maxTurns = 99
          assert.equal(original.condition, "unfinished revision")
          assert.notEqual(original.options.maxTurns, 99)
          assert.equal(original.goalId, snapshot.goalId)
          assert.notEqual(original.runId, snapshot.runId)
          resolveVerdict({ approved: true })
          const result = await pending
          if (completion === "tool") assert.equal(JSON.parse(result).ok, false)
          assert.equal(testInternals.currentGoal(sessionID), original)
          assert.equal(original.condition, "unfinished revision")
          assert.deepEqual({ startedAt: original.startedAt, turnCount: original.turnCount, totalTokens: original.totalTokens }, budget)
        } finally { resolveVerdict?.({ approved: false }); await hooks.dispose() }
      })
    }
  }
})
