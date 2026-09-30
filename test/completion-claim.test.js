import assert from "node:assert/strict"
import test from "node:test"
import { serializeCompletionClaim } from "../src/completion-claim.js"
import { GoalPlugin, testInternals } from "../src/goal-plugin.js"

test("completion rejects contradictory exit codes and bounds all evidence", async () => {
  const hooks = await GoalPlugin({ client: { session: {} } }, { persistState: false, auditMessages: false, lifecycleMessages: false })
  const context = { sessionID: "claim-validation" }
  try {
    await hooks.tool.goal_set.execute({ objective: "tests pass" }, context)
    for (const claim of [
      { checks: [{ command: "npm test", result: "passed", exitCode: 1 }] },
      { checks: [{ command: "npm test", result: "not-run", exitCode: 0 }] },
      { criteria: [{ criterion: "proof", evidence: Array(21).fill("proof") }] },
      { criteria: [{ criterion: "proof", evidence: Array(20).fill("x".repeat(500)) }] },
      { changedFiles: Array(100).fill("x".repeat(100)) },
    ]) {
      const result = JSON.parse(await hooks.tool.goal_complete.execute({ summary: "done", ...claim }, context))
      assert.equal(result.ok, false)
      assert.equal(result.error, "invalid_completion_claim")
      assert.equal(testInternals.currentGoal(context.sessionID).condition, "tests pass")
    }
    const success = JSON.parse(await hooks.tool.goal_complete.execute({ summary: "done", checks: [{ command: "npm test", result: "passed", exitCode: 0 }] }, context))
    assert.equal(success.ok, true)
    assert.equal(testInternals.currentGoal(context.sessionID), null)
  } finally { await hooks.dispose() }
})

test("completion claims reject non-object input without throwing", () => {
  for (const input of [null, [], "done", 1]) {
    assert.deepEqual(serializeCompletionClaim(input), {
      ok: false,
      error: "summary must be a non-empty string",
    })
  }
})

test("manual not-run checks retain their explanation without undefined fields", () => {
  assert.deepEqual(
    serializeCompletionClaim({
      summary: "Reviewed manually",
      checks: [{ result: "not-run", explanation: "No executable test exists" }],
    }),
    {
      ok: true,
      evidence: [
        "Summary: Reviewed manually",
        "Check: manual check | not-run | No executable test exists",
      ].join("\n"),
    },
  )
})
