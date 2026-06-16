import { describe, expect, test } from "bun:test"
import { applyTurnId } from "./ws-pool"

function entry() {
  return { lastUsedAt: 0, busy: false, fallback: false, streamFailures: 0 } as Parameters<typeof applyTurnId>[0]
}

function body(input: unknown[]) {
  return {
    type: "response.create",
    input,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "sid",
        thread_id: "sid",
        thread_source: "user",
        turn_id: "PER_REQUEST_SHOULD_BE_OVERRIDDEN",
        sandbox: "seccomp",
        turn_started_at_unix_ms: 1,
        request_kind: "turn",
        window_id: "sid:0",
      }),
    },
  }
}

function meta(result: Record<string, unknown>) {
  const cm = result.client_metadata as Record<string, string>
  return JSON.parse(cm["x-codex-turn-metadata"]!) as Record<string, unknown>
}

function turnID(result: Record<string, unknown>) {
  return meta(result).turn_id as string
}

describe("applyTurnId", () => {
  test("keeps one turn_id across a tool-loop and ignores the per-request base id", () => {
    const e = entry()
    const userTurn = turnID(applyTurnId(e, body([{ type: "message", role: "user", content: [] }])))
    const cont1 = turnID(applyTurnId(e, body([{ type: "function_call_output", call_id: "a", output: "x" }])))
    const cont2 = turnID(applyTurnId(e, body([{ type: "function_call_output", call_id: "b", output: "y" }])))

    expect(userTurn).not.toBe("PER_REQUEST_SHOULD_BE_OVERRIDDEN")
    expect(cont1).toBe(userTurn)
    expect(cont2).toBe(userTurn)
  })

  test("rotates turn_id when a new (non-output) message starts a turn", () => {
    const e = entry()
    const first = turnID(applyTurnId(e, body([{ type: "message", role: "user", content: [] }])))
    turnID(applyTurnId(e, body([{ type: "function_call_output", call_id: "a", output: "x" }])))
    const second = turnID(applyTurnId(e, body([{ type: "message", role: "user", content: [] }])))

    expect(second).not.toBe(first)
  })

  test("turn_started_at is stable across the tool-loop", () => {
    const e = entry()
    const startedAt = (result: Record<string, unknown>) => meta(result).turn_started_at_unix_ms
    const t0 = startedAt(applyTurnId(e, body([{ type: "message", role: "user", content: [] }])))
    const t1 = startedAt(applyTurnId(e, body([{ type: "function_call_output", call_id: "a", output: "x" }])))
    expect(t1).toBe(t0)
  })
})
