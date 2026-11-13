import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE_OVERRIDE_MESSAGE,
  checkBashMutation,
  computeTranscriptState,
  shortModelLabel,
  splitModelSpec,
  type TranscriptMessageLike,
} from "../extensions/core.ts";

test("splitModelSpec and shortModelLabel parse provider and modelId", () => {
  assert.deepEqual(splitModelSpec("magpie/auto/claude-opus-5-5", "magpie"), {
    provider: "magpie",
    modelId: "auto/claude-opus-5-5",
  });
  assert.deepEqual(splitModelSpec("auto/deepseek-flash", "magpie"), {
    provider: "magpie",
    modelId: "auto/deepseek-flash",
  });
  assert.deepEqual(splitModelSpec("anthropic/claude-sonnet-4-5", "magpie"), {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
  });
  assert.equal(shortModelLabel("magpie/auto/claude-opus-5-5"), "claude-opus-5-5");
});

test("computeTranscriptState starts in plan phase on a new user turn", () => {
  const messages: TranscriptMessageLike[] = [{ role: "user" }];
  const state = computeTranscriptState(messages, 30);
  assert.equal(state.phase, "plan");
  assert.equal(state.stepsSinceHandoff, 0);
  assert.equal(state.handbackPending, false);
});

test("computeTranscriptState transitions to execute after exit_plan_mode succeeds", () => {
  const messages: TranscriptMessageLike[] = [
    { role: "user" },
    { role: "assistant" },
    { role: "toolResult", toolName: "exit_plan_mode", isError: false },
  ];
  const state = computeTranscriptState(messages, 30);
  assert.equal(state.phase, "execute");
  assert.equal(state.stepsSinceHandoff, 0);
  assert.equal(state.handbackPending, false);
});

test("computeTranscriptState sets handbackPending at 30-step boundary and resets on enter_plan_mode", () => {
  const messages: TranscriptMessageLike[] = [
    { role: "user" },
    { role: "assistant" },
    { role: "toolResult", toolName: "exit_plan_mode", isError: false },
    { role: "assistant" },
    { role: "toolResult", toolName: "edit", isError: false },
    { role: "assistant" },
    { role: "toolResult", toolName: "bash", isError: false },
    { role: "assistant" },
    { role: "toolResult", toolName: "edit", isError: false },
  ];

  const atLimit = computeTranscriptState(messages, 3);
  assert.equal(atLimit.phase, "execute");
  assert.equal(atLimit.stepsSinceHandoff, 3);
  assert.equal(atLimit.handbackPending, true);

  messages.push({ role: "assistant" });
  messages.push({ role: "toolResult", toolName: "enter_plan_mode", isError: false });

  const afterHandback = computeTranscriptState(messages, 3);
  assert.equal(afterHandback.phase, "plan");
  assert.equal(afterHandback.stepsSinceHandoff, 0);
  assert.equal(afterHandback.handbackPending, false);
});

test("computeTranscriptState respects manual PHASE_OVERRIDE_MESSAGE", () => {
  const messages: TranscriptMessageLike[] = [
    { role: "user" },
    { customType: PHASE_OVERRIDE_MESSAGE, details: { phase: "execute" } },
  ];
  const state = computeTranscriptState(messages, 30);
  assert.equal(state.phase, "execute");
  assert.equal(state.stepsSinceHandoff, 0);
});

test("checkBashMutation allows read-only commands and blocks workspace-mutating commands", () => {
  assert.equal(checkBashMutation("rg -n 'computeTranscriptState' extensions/"), undefined);
  assert.equal(checkBashMutation("git status --short && git diff --stat"), undefined);
  assert.equal(checkBashMutation("ls -la /tmp 2>/dev/null"), undefined);

  assert.equal(checkBashMutation("rm -rf dist/"), "filesystem mutation");
  assert.equal(checkBashMutation("git commit -m 'wip'"), "git state modification");
  assert.equal(checkBashMutation("echo hello > out.txt"), "shell output redirection to file");
  assert.equal(checkBashMutation("sed -i '' 's/a/b/g' file.ts"), "sed in-place edit");
});
