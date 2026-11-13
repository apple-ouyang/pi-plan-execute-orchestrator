# Changelog

All notable changes to `pi-plan-execute-orchestrator` will be documented in this file.

## [0.1.0] - 2026-11-13

### Added
- Single-conversation two-phase Plan & Execute Orchestrator extension for `@earendil-works/pi-coding-agent`.
- Native `pi.registerVirtualModel` registration so each Planner + Executor pair appears as a selectable virtual model in Pi TUI (`/model`), CLI (`--model`), ACP, and Paseo.
- Full state machine (`plan` ↔ `execute`) derived deterministically from conversation history (`exit_plan_mode` and `enter_plan_mode` tool calls):
  - Starts every user turn in `plan` mode on the Planner model.
  - Pure Q&A / read-only tasks finish directly on the Planner model with 0 handoffs.
  - Mutating tasks call `exit_plan_mode(plan)` to hand off to the Executor model in the same conversation.
  - Hard 30-step review checkpoint (`reviewEvery = 30`): locks non-handback tools and prompts the Executor to call `enter_plan_mode(reason, status_report)` so the Planner can audit progress and choose one of 3 branches (continue, revise/undo drift, or complete).
- Hard read-only tool gate (`tool_call` hook) during `plan` mode:
  - Blocks `edit` / `write` tools before execution.
  - Inspects `bash` commands to block workspace-mutating operations (`rm`, `mv`, `git commit`, `npm install`, `sed -i`, shell redirects `>`, etc.) while allowing read-only inspection (`rg`, `git status`, `git diff`, `ls`, `cat`, etc.).
- Interactive `/orchestrator` slash command (`status`, `pair <planner> <executor>`, `reset`, `plan`, `execute`, `init`).
- Custom configuration via `~/.pi/agent/orchestrators.json`.
