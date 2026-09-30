import assert from "node:assert/strict"
import test from "node:test"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

test("goal_set reports validation failures without replacing an existing goal", async () => {
  const hooks = await GoalPlugin({ client: { session: {} } }, { persistState: false, lifecycleMessages: false })
  const context = { sessionID: "tool-validation" }
  try {
    await hooks.tool.goal_set.execute({ objective: "preserve me" }, context)
    const original = testInternals.currentGoal(context.sessionID)
    for (const args of [
      { objective: "x".repeat(4001) },
      { objective: "task", successCriteria: "x".repeat(2001) },
      { objective: "task", constraints: "x".repeat(2001) },
      { objective: "task", mode: "invalid" },
      ...["maxTurns", "maxTokens", "maxDurationMs"].flatMap(field => [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(value => ({ objective: "task", [field]: value }))),
      { objective: "task", maxCostUsd: -1 },
      { objective: "task", maxCostUsd: NaN },
    ]) {
      const result = JSON.parse(await hooks.tool.goal_set.execute(args, context))
      assert.equal(result.ok, false, JSON.stringify(args))
      assert.match(result.error, /^invalid_/)
      assert.equal(testInternals.currentGoal(context.sessionID), original)
      const legacy = await hooks.tool.set_goal.execute(args, context)
      assert.equal(legacy, result.message)
      assert.equal(testInternals.currentGoal(context.sessionID), original)
    }
    const success = JSON.parse(await hooks.tool.goal_set.execute({ objective: "valid", maxTurns: 3, maxCostUsd: 0.5 }, context))
    assert.equal(success.ok, true)
    assert.equal(testInternals.currentGoal(context.sessionID).options.maxTurns, 3)
    assert.equal(testInternals.currentGoal(context.sessionID).options.maxCostUsd, 0.5)
  } finally { await hooks.dispose() }
})
