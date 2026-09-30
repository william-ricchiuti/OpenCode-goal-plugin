import assert from "node:assert/strict"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

const sessionID = "plan-activation"
const command = (hooks, args) => hooks["command.execute.before"]({ sessionID, command: "goal", arguments: args }, { parts: [] })
test("every work-starting command holds under restricted agents before tools run", async (t) => {
  for (const args of ["add another", "sequence first; second", "resume", "edit revised", "focus 1"]) {
    for (const primed of [false, true]) {
      await t.test(`${args}, agent ${primed ? "known" : "routed"}`, async () => {
        const hooks = await GoalPlugin({ client: { session: { get: async () => ({ data: {} }), messages: async () => ({ data: [] }) } } }, { persistState: false, auditMessages: false, lifecycleMessages: false })
        try {
          // Seed state without recording an agent; the command is the first
          // host-routed turn carrying the planning agent in the late case.
          await hooks.tool.goal_set.execute({ objective: "original" }, { sessionID })
          if (args === "resume") await command(hooks, "pause")
          if (args === "focus 1") await command(hooks, "add background original")
          if (primed) await hooks["chat.params"]({ sessionID, agent: "plan" })
          const output = { parts: [] }
          await hooks["command.execute.before"]({ sessionID, command: "goal", arguments: args }, output)
          const parts = output.parts.map(part => ({ ...part, sessionID, messageID: "routed" }))
          await hooks["chat.message"]({ sessionID, agent: "plan", messageID: "routed" }, { message: { id: "routed", sessionID, role: "user" }, parts })
          const goal = testInternals.currentGoal(sessionID)
          assert.equal(goal.stopped, true)
          assert.equal(goal.stopReason, "plan agent active")
          assert.match(parts[0].text, /planning-only/)
          assert.doesNotMatch(parts[0].text, /Start working toward this goal now/)
          await assert.rejects(hooks["tool.execute.before"]({ sessionID, tool: "bash" }), /blocked/)
        } finally { await hooks.dispose() }
      })
    }
  }
})

test("goal tools hold creation and resume under restricted agents", async () => {
  const hooks = await GoalPlugin({ client: { session: {} } }, { persistState: false, auditMessages: false, lifecycleMessages: false })
  try {
    const context = { sessionID, agent: "plan" }
    const set = JSON.parse(await hooks.tool.goal_set.execute({ objective: "held tool goal" }, context))
    assert.match(set.message, /held goal/)
    assert.equal(testInternals.currentGoal(sessionID).stopReason, "plan agent active")
    const resume = JSON.parse(await hooks.tool.goal_resume.execute({}, context))
    assert.match(resume.message, /held while Plan/)
    assert.equal(testInternals.currentGoal(sessionID).stopped, true)
  } finally { await hooks.dispose() }
})
