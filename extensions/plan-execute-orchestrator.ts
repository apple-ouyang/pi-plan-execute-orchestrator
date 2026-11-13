/**
 * Plan-Execute Orchestrator Extension for Pi (`pi-plan-execute-orchestrator`)
 *
 * Implements single-conversation, two-phase Planner <-> Executor orchestration:
 * 1. Planning Phase (`phase = "plan"`):
 *    - Runs on the strong Planner model (e.g. Claude Opus 5.5, GPT-6.1 Sol, GLM-5.3).
 *    - Every new user turn starts in Plan mode (`reason === "user"`).
 *    - Hard read-only tool gate (`edit`, `write`, and workspace-mutating `bash` commands are blocked).
 *    - Pure Q&A / read-only tasks are answered directly by the Planner (0 handoffs).
 *    - Mutating tasks call `exit_plan_mode(plan)` to hand off to the Executor within the same turn.
 * 2. Execution Phase (`phase = "execute"`):
 *    - Runs on the fast Executor model (e.g. DeepSeek V4.1 Flash) with full tool access.
 *    - If execution completes smoothly, the Executor reports directly to the user and stops (no handback).
 * 3. Handback & Review (`enter_plan_mode` + 30-step hard gate):
 *    - Soft rule: if a step fails twice or a plan assumption is falsified, Executor calls `enter_plan_mode`.
 *    - Hard gate: after every 30 Executor invocations since handoff (`stepsSinceHandoff % 30 === 0`),
 *      `handbackPending` is set and all tools except `enter_plan_mode` are refused.
 *    - On handback, Planner performs a read-only audit and chooses 1 of 3 actions:
 *      (1) continue remaining steps via `exit_plan_mode`, (2) undo/revise plan via `exit_plan_mode`,
 *      or (3) summarize completion directly to the user.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRoute,
	type ModelRouteRequest,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	checkBashMutation,
	computeTranscriptState,
	PHASE_OVERRIDE_MESSAGE,
	shortModelLabel,
	splitModelSpec,
} from "./core.ts";

export { checkBashMutation, computeTranscriptState, PHASE_OVERRIDE_MESSAGE, shortModelLabel, splitModelSpec };

const DEFAULT_PROVIDER = "magpie";
const DEFAULT_REVIEW_EVERY = 30;
const PAIR_OVERRIDE_ENTRY = "orchestrator-pair-override";

export interface OrchestratorPreset {
	provider?: string;
	id: string;
	name: string;
	planner: string;
	executor: string;
	reviewEvery?: number;
}

export interface OrchestratorsConfig {
	provider?: string;
	reviewEvery?: number;
	aliases?: Record<string, string>;
	presets: OrchestratorPreset[];
}

export interface OrchestratorRouterState {
	phase: "plan" | "execute";
	stepsSinceHandoff: number;
	handbackPending: boolean;
	planner: string;
	executor: string;
	activeModel: string;
}

interface PairOverrideData {
	planner: string;
	executor: string;
}

const DEFAULT_CONFIG: OrchestratorsConfig = {
	provider: DEFAULT_PROVIDER,
	reviewEvery: DEFAULT_REVIEW_EVERY,
	aliases: {
		opus: "magpie/auto/claude-opus-5-5",
		sonnet: "magpie/auto/claude-sonnet-5-5",
		sol: "magpie/codex/gpt-6.1-sol",
		terra: "magpie/codex/gpt-6.1-terra",
		glm: "magpie/auto/glm-5.3",
		"glm-flash": "magpie/auto/glm-5.3-flash",
		deepseek: "magpie/auto/deepseek-flash",
		ds: "magpie/auto/deepseek-flash",
		"ds-ablit": "magpie/group/deepseek-v4.1-flash-abliterated",
		hy4: "magpie/workbuddy/hy4free",
	},
	presets: [
		{
			id: "orchestrator-opus-ds",
			name: "Orchestrator · Opus 5.5 + DeepSeek Flash",
			planner: "magpie/auto/claude-opus-5-5",
			executor: "magpie/auto/deepseek-flash",
		},
		{
			id: "orchestrator-sol-ds",
			name: "Orchestrator · GPT-6.1 Sol + DeepSeek Flash",
			planner: "magpie/codex/gpt-6.1-sol",
			executor: "magpie/auto/deepseek-flash",
		},
		{
			id: "orchestrator-glm-ds",
			name: "Orchestrator · GLM-5.3 + DeepSeek Flash",
			planner: "magpie/auto/glm-5.3",
			executor: "magpie/auto/deepseek-flash",
		},
	],
};

function loadConfig(): OrchestratorsConfig {
	const configPath = path.join(getAgentDir(), "orchestrators.json");
	try {
		if (fs.existsSync(configPath)) {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<OrchestratorsConfig>;
			return {
				provider: parsed.provider || DEFAULT_CONFIG.provider,
				reviewEvery:
					typeof parsed.reviewEvery === "number" && parsed.reviewEvery > 0
						? parsed.reviewEvery
						: DEFAULT_CONFIG.reviewEvery,
				aliases: { ...DEFAULT_CONFIG.aliases, ...(parsed.aliases ?? {}) },
				presets: Array.isArray(parsed.presets) && parsed.presets.length > 0 ? parsed.presets : DEFAULT_CONFIG.presets,
			};
		}
	} catch {
		// Fall back to built-in config on parse errors
	}
	return DEFAULT_CONFIG;
}

const PLAN_EXECUTE_SYSTEM_PROTOCOL = `You are operating under the Plan-Execute Orchestrator protocol:
1. Two Models, One Conversation:
   - Planning Phase (Read-Only): Runs on the Planning model. Workspace-mutating tools (edit, write, mutating bash) are blocked by a hard gate.
   - Execution Phase (Read-Write): Runs on the Execution model with full tool access.
2. Planning Phase Rules:
   - Every new user message starts in the Planning phase.
   - If the user request is pure Q&A, explanation, or read-only inspection, use read-only tools (read, grep, find, ls, read-only bash) and answer the user directly WITHOUT calling exit_plan_mode.
   - If the task requires editing files or running mutating commands, inspect the relevant files first, then call exit_plan_mode with a concrete implementation plan containing:
     a) Ordered numbered steps;
     b) Target file paths and symbols/functions;
     c) Exact verification commands;
     d) "Re-plan if:" conditions (assumptions that, if falsified during execution, require handing back).
3. Execution Phase Rules:
   - Carry out the plan step by step and run the verification commands.
   - When all steps and verifications succeed, report the final summary directly to the user and stop (do NOT call enter_plan_mode on normal completion).
   - Failure rule: The first failed attempt at a step is yours to fix; the second consecutive failure is the planning model's. Stop and call enter_plan_mode with what you found — do not try a third approach.
   - Hard 30-step review gate: After 30 execution steps, all tools except enter_plan_mode are locked. Call enter_plan_mode immediately with a status report.
4. Handback Review (3-Way Branch):
   - When enter_plan_mode hands control back to the Planning model, inspect the workspace (read-only) and choose one of three actions:
     (1) On track: call exit_plan_mode with only the remaining steps;
     (2) Drifted or blocked: call exit_plan_mode with steps to undo/fix the drift and a revised plan;
     (3) Already complete: summarize the completed result directly to the user and finish.`;

function getLatestPairOverride(branch: readonly SessionEntry[]): PairOverrideData | undefined {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i] as { type?: string; customType?: string; data?: PairOverrideData | null };
		if (entry.type === "custom" && entry.customType === PAIR_OVERRIDE_ENTRY) {
			if (entry.data && entry.data.planner && entry.data.executor) {
				return entry.data;
			}
			return undefined;
		}
	}
	return undefined;
}

const ExitPlanModeParams = Type.Object({
	plan: Type.String({
		description:
			"Ordered implementation plan with: (1) numbered steps, (2) target files and symbols, (3) verification commands, and (4) 'Re-plan if:' conditions.",
	}),
});

const EnterPlanModeParams = Type.Object({
	reason: Type.String({
		description:
			"Why control is being handed back to the planning model (e.g. '30-step review due', 'step failed twice', 'plan assumption falsified').",
	}),
	status_report: Type.String({
		description:
			"Structured status report covering: (1) steps completed so far, (2) files modified, (3) exact error or blocker encountered, and (4) remaining steps.",
	}),
});

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const defaultProvider = config.provider || DEFAULT_PROVIDER;
	const reviewEvery = config.reviewEvery || DEFAULT_REVIEW_EVERY;
	const presetsByKey = new Map<string, Required<OrchestratorPreset>>();

	for (const preset of config.presets) {
		const provider = preset.provider || defaultProvider;
		const fullPreset: Required<OrchestratorPreset> = {
			provider,
			id: preset.id,
			name: preset.name,
			planner: preset.planner,
			executor: preset.executor,
			reviewEvery: preset.reviewEvery || reviewEvery,
		};
		presetsByKey.set(`${provider}/${preset.id}`, fullPreset);
	}

	let liveState: OrchestratorRouterState = {
		phase: "plan",
		stepsSinceHandoff: 0,
		handbackPending: false,
		planner: config.presets[0]?.planner ?? "magpie/auto/claude-opus-5-5",
		executor: config.presets[0]?.executor ?? "magpie/auto/deepseek-flash",
		activeModel: config.presets[0]?.planner ?? "magpie/auto/claude-opus-5-5",
	};

	function getPresetForModel(
		model: { provider?: string; id?: string } | undefined,
	): Required<OrchestratorPreset> | undefined {
		if (!model?.provider || !model?.id) return undefined;
		return presetsByKey.get(`${model.provider}/${model.id}`);
	}

	function resolveModelSpec(raw: string): string {
		const key = raw.trim().toLowerCase();
		if (config.aliases && config.aliases[key]) {
			return config.aliases[key];
		}
		const { provider, modelId } = splitModelSpec(raw, defaultProvider);
		return `${provider}/${modelId}`;
	}

	function findPhysicalModel(ctx: ExtensionContext, spec: string): Model<Api> {
		const resolved = resolveModelSpec(spec);
		const { provider, modelId } = splitModelSpec(resolved, defaultProvider);
		const found = ctx.modelRegistry.find(provider, modelId);
		if (!found) {
			throw new Error(
				`Orchestrator target model "${provider}/${modelId}" not found in Pi model catalog. Check ~/.pi/agent/models.json or use /orchestrator pair <planner> <executor>.`,
			);
		}
		return found;
	}

	function updateStatusWidget(
		ctx: ExtensionContext | undefined,
		preset: Required<OrchestratorPreset> | undefined,
	): void {
		if (!ctx?.hasUI) return;
		if (!preset) {
			ctx.ui.setStatus("orchestrator", undefined);
			return;
		}
		const plannerShort = shortModelLabel(liveState.planner);
		const execShort = shortModelLabel(liveState.executor);
		if (liveState.phase === "plan") {
			ctx.ui.setStatus("orchestrator", `🧭 Plan(${plannerShort}) → Exec(${execShort})`);
		} else if (liveState.handbackPending) {
			ctx.ui.setStatus(
				"orchestrator",
				`⏸ Review Due [${liveState.stepsSinceHandoff}/${preset.reviewEvery}] → ${plannerShort}`,
			);
		} else {
			ctx.ui.setStatus(
				"orchestrator",
				`⚡ Exec [${liveState.stepsSinceHandoff}/${preset.reviewEvery}](${execShort})`,
			);
		}
	}

	function syncOrchestratorTools(active: boolean): void {
		try {
			const current = pi.getActiveTools();
			const hasExit = current.includes("exit_plan_mode");
			const hasEnter = current.includes("enter_plan_mode");
			if (active && (!hasExit || !hasEnter)) {
				pi.setActiveTools([...new Set([...current, "exit_plan_mode", "enter_plan_mode"])]);
			} else if (!active && (hasExit || !hasEnter)) {
				if (hasExit || hasEnter) {
					pi.setActiveTools(current.filter((name) => name !== "exit_plan_mode" && name !== "enter_plan_mode"));
				}
			}
		} catch {
			// Ignore during early initialization before runtime binds
		}
	}

	// Register virtual models for all configured presets
	for (const preset of presetsByKey.values()) {
		pi.registerVirtualModel<OrchestratorRouterState>({
			provider: preset.provider,
			id: preset.id,
			name: preset.name,
			thinkingLevels: ["low", "high", "max"] as readonly ModelThinkingLevel[],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			route(
				request: ModelRouteRequest<OrchestratorRouterState>,
				ctx: ExtensionContext,
			): ModelRoute<OrchestratorRouterState> {
				const override = getLatestPairOverride(ctx.sessionManager.getBranch());
				const plannerSpec = override?.planner ?? preset.planner;
				const executorSpec = override?.executor ?? preset.executor;

				// Requests outside the agent loop (e.g. compaction summaries) go to the fast Executor model
				if (request.reason === "direct") {
					const execModel = findPhysicalModel(ctx, executorSpec);
					return { model: execModel, thinkingLevel: request.thinkingLevel };
				}

				const snapshot = computeTranscriptState(request.messages, preset.reviewEvery);
				const targetSpec = snapshot.phase === "plan" ? plannerSpec : executorSpec;
				const targetModel = findPhysicalModel(ctx, targetSpec);

				const nextState: OrchestratorRouterState = {
					phase: snapshot.phase,
					stepsSinceHandoff: snapshot.stepsSinceHandoff,
					handbackPending: snapshot.handbackPending,
					planner: plannerSpec,
					executor: executorSpec,
					activeModel: `${targetModel.provider}/${targetModel.id}`,
				};

				liveState = nextState;
				updateStatusWidget(ctx, preset);

				const prev = request.state;
				const stateChanged =
					!prev ||
					prev.phase !== nextState.phase ||
					prev.stepsSinceHandoff !== nextState.stepsSinceHandoff ||
					prev.handbackPending !== nextState.handbackPending ||
					prev.planner !== nextState.planner ||
					prev.executor !== nextState.executor ||
					prev.activeModel !== nextState.activeModel;

				return {
					model: targetModel,
					thinkingLevel: request.thinkingLevel,
					state: stateChanged ? nextState : request.state,
				};
			},
		});
	}

	// Register exit_plan_mode tool (Planner -> Executor handoff)
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit Plan Mode (Hand off to Executor)",
		description:
			"Finish read-only planning and hand the implementation plan to the execution model in the same conversation. Only call this in Plan mode when workspace changes or mutating commands are required.",
		promptSnippet: "Hand off a completed implementation plan from the read-only Planning model to the Execution model",
		parameters: ExitPlanModeParams,
		defaultActive: false,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const planText = params.plan.trim();
			if (!planText) {
				return {
					content: [{ type: "text", text: "exit_plan_mode requires a non-empty `plan`." }],
					details: { error: "empty_plan" },
					isError: true,
				};
			}

			liveState = {
				...liveState,
				phase: "execute",
				stepsSinceHandoff: 0,
				handbackPending: false,
			};
			updateStatusWidget(ctx, getPresetForModel(ctx.model));

			const handoffText = [
				"[PLAN MODE HANDOFF -> EXECUTION PHASE]",
				`Plan mode is now OFF. This turn now runs on the Execution model (${shortModelLabel(liveState.executor)}) with full write access (edit, write, bash).`,
				"Carry out the plan below step by step:",
				"- Run the verification commands specified in the plan.",
				"- When all steps are complete and verified, summarize the result directly to the user and stop (do NOT call enter_plan_mode on completion).",
				"- The first failed attempt at a step is yours to fix; the second consecutive failure is the planning model's. Stop and call enter_plan_mode with what you found — do not try a third approach.",
				"- If any 'Re-plan if:' condition is triggered, call enter_plan_mode immediately.",
				"",
				"=== APPROVED IMPLEMENTATION PLAN ===",
				planText,
			].join("\n");

			return {
				content: [{ type: "text", text: handoffText }],
				details: {
					phase: "execute",
					executor: liveState.executor,
					plan: planText,
				},
			};
		},
	});

	// Register enter_plan_mode tool (Executor -> Planner handback)
	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter Plan Mode (Hand back to Planner)",
		description:
			"Hand control back from the Execution model to the read-only Planning model for review or re-planning when a step fails twice, a plan assumption is falsified, or the 30-step review gate triggers.",
		promptSnippet: "Hand control back to the Planning model when blocked, after 2 failures, or when a 30-step review is due",
		parameters: EnterPlanModeParams,
		defaultActive: false,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			liveState = {
				...liveState,
				phase: "plan",
				stepsSinceHandoff: 0,
				handbackPending: false,
			};
			updateStatusWidget(ctx, getPresetForModel(ctx.model));

			const handbackText = [
				"[EXECUTION HANDBACK -> PLANNING PHASE (READ-ONLY REVIEW)]",
				`The Execution model (${shortModelLabel(liveState.executor)}) handed control back to you (${shortModelLabel(liveState.planner)}).`,
				`Reason: ${params.reason.trim()}`,
				"",
				"=== EXECUTION STATUS REPORT ===",
				params.status_report.trim(),
				"",
				"=== PLANNER 3-WAY REVIEW PROTOCOL ===",
				"Plan mode is ON (read-only). Inspect the current workspace state if needed, then choose ONE of these 3 actions:",
				"1. On track (periodic 30-step review, work is proceeding well): call exit_plan_mode with ONLY the remaining steps.",
				"2. Drifted or blocked (repeated failure or wrong assumption): call exit_plan_mode with steps to undo/fix any bad changes and a revised plan.",
				"3. Actually complete: do NOT call exit_plan_mode; report the final summary directly to the user and end the turn.",
			].join("\n");

			return {
				content: [{ type: "text", text: handbackText }],
				details: {
					phase: "plan",
					planner: liveState.planner,
					reason: params.reason,
					statusReport: params.status_report,
				},
			};
		},
	});

	// Activate/deactivate orchestrator tools and status when session starts or model changes
	pi.on("session_start", (_event, ctx) => {
		const preset = getPresetForModel(ctx.model);
		syncOrchestratorTools(!!preset);
		if (preset) {
			const override = getLatestPairOverride(ctx.sessionManager.getBranch());
			liveState.planner = override?.planner ?? preset.planner;
			liveState.executor = override?.executor ?? preset.executor;
		}
		updateStatusWidget(ctx, preset);
	});

	pi.on("model_select", (event, ctx) => {
		const preset = getPresetForModel(event.model);
		syncOrchestratorTools(!!preset);
		if (preset) {
			const override = getLatestPairOverride(ctx.sessionManager.getBranch());
			liveState = {
				phase: "plan",
				stepsSinceHandoff: 0,
				handbackPending: false,
				planner: override?.planner ?? preset.planner,
				executor: override?.executor ?? preset.executor,
				activeModel: preset.planner,
			};
		}
		updateStatusWidget(ctx, preset);
	});

	// Inject <plan_execute_protocol> system prompt section and ensure handoff tools are active
	pi.on("before_agent_start", (event, ctx) => {
		const preset = getPresetForModel(ctx.model);
		if (!preset) return undefined;

		syncOrchestratorTools(true);
		const tools = event.systemPromptOptions.selectedTools;
		if (!tools.includes("exit_plan_mode")) tools.push("exit_plan_mode");
		if (!tools.includes("enter_plan_mode")) tools.push("enter_plan_mode");

		const override = getLatestPairOverride(ctx.sessionManager.getBranch());
		const plannerLabel = shortModelLabel(override?.planner ?? preset.planner);
		const executorLabel = shortModelLabel(override?.executor ?? preset.executor);

		event.systemPromptOptions.sections.plan_execute_protocol = `${PLAN_EXECUTE_SYSTEM_PROTOCOL}\n\nActive Orchestrator Pair: Planner = ${plannerLabel}, Executor = ${executorLabel}, Review Gate = every ${preset.reviewEvery} execution steps.`;

		if (event.messageType === "user") {
			liveState = {
				...liveState,
				phase: "plan",
				stepsSinceHandoff: 0,
				handbackPending: false,
				planner: override?.planner ?? preset.planner,
				executor: override?.executor ?? preset.executor,
			};
			updateStatusWidget(ctx, preset);
		}
		return undefined;
	});

	// Inject the 30-step review reminder at the tail of messages when handbackPending is true
	pi.on("context", (event, ctx) => {
		const preset = getPresetForModel(ctx.model);
		if (!preset) return undefined;

		const snapshot = computeTranscriptState(event.messages, preset.reviewEvery);
		liveState = {
			...liveState,
			phase: snapshot.phase,
			stepsSinceHandoff: snapshot.stepsSinceHandoff,
			handbackPending: snapshot.handbackPending,
		};
		updateStatusWidget(ctx, preset);

		if (!snapshot.handbackPending) return undefined;

		const reminderMessage: AgentMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `[plan review due] ${snapshot.stepsSinceHandoff} execution invocations have run since the plan was handed off. All tools except enter_plan_mode are now refused. Call enter_plan_mode immediately with a status report (completed steps, current workspace state, remaining steps) so the planning model (${shortModelLabel(liveState.planner)}) can review progress.`,
				},
			],
			timestamp: Date.now(),
		};

		return {
			messages: [...event.messages, reminderMessage],
		};
	});

	// Enforce hard read-only gate in Plan mode and hard 30-step review gate in Execute mode
	pi.on("tool_call", (event, ctx) => {
		const preset = getPresetForModel(ctx.model);
		if (!preset) return undefined;

		if (liveState.phase === "plan") {
			if (event.toolName === "edit" || event.toolName === "write") {
				return {
					block: true,
					reason: `Plan mode is on, and ${event.toolName} changes the workspace. Plan mode is read-only: finish the plan and call exit_plan_mode with it; the execution model (${shortModelLabel(liveState.executor)}) makes the changes.`,
				};
			}
			if (event.toolName === "bash") {
				const cmd = String((event.input as { command?: string })?.command ?? "");
				const mutation = checkBashMutation(cmd);
				if (mutation) {
					return {
						block: true,
						reason: `Plan mode is on, and this bash command changes the workspace (${mutation}). Plan mode is read-only: finish the plan and call exit_plan_mode with it; the execution model (${shortModelLabel(liveState.executor)}) runs mutating commands.`,
					};
				}
			}
			if (event.toolName === "enter_plan_mode") {
				return {
					block: true,
					reason: "Already in Plan mode. Inspect the codebase with read-only tools, then call exit_plan_mode with your plan.",
				};
			}
			return undefined;
		}

		// Execution phase: check 30-step hard review gate
		if (liveState.handbackPending && event.toolName !== "enter_plan_mode") {
			return {
				block: true,
				reason: `A plan review is due (${liveState.stepsSinceHandoff} execution invocations reached): ${event.toolName} is refused until you hand back. Call enter_plan_mode now with a status report.`,
			};
		}

		if (event.toolName === "exit_plan_mode") {
			return {
				block: true,
				reason: "Already in Execution mode. Carry out the plan directly, or call enter_plan_mode if you need to hand back to the planning model.",
			};
		}

		return undefined;
	});

	// Slash command `/orchestrator` for dynamic pairing, config init, and status inspection
	pi.registerCommand("orchestrator", {
		description:
			"Inspect or dynamically override Orchestrator Planner/Executor models: /orchestrator [status | pair <planner> <executor> | reset | plan | execute | init]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "status").toLowerCase();
			const preset = getPresetForModel(ctx.model);

			if (sub === "init") {
				const targetPath = path.join(getAgentDir(), "orchestrators.json");
				if (fs.existsSync(targetPath)) {
					ctx.ui.notify(`Config already exists at ${targetPath}`, "info");
					return;
				}
				fs.writeFileSync(targetPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
				ctx.ui.notify(`Created default orchestrator config at ${targetPath}`, "info");
				return;
			}

			if (sub === "pair" || sub === "set") {
				if (parts.length < 3) {
					ctx.ui.notify(
						"Usage: /orchestrator pair <planner> <executor> (e.g. /orchestrator pair opus ds, or /orchestrator pair sol glm-flash)",
						"warning",
					);
					return;
				}
				try {
					const plannerModel = findPhysicalModel(ctx, parts[1]);
					const executorModel = findPhysicalModel(ctx, parts[2]);
					const override: PairOverrideData = {
						planner: `${plannerModel.provider}/${plannerModel.id}`,
						executor: `${executorModel.provider}/${executorModel.id}`,
					};
					pi.appendEntry(PAIR_OVERRIDE_ENTRY, override);
					liveState = {
						...liveState,
						planner: override.planner,
						executor: override.executor,
					};
					updateStatusWidget(ctx, preset);
					ctx.ui.notify(
						`Orchestrator pair updated for this session:\nPlanner (read-only): ${override.planner}\nExecutor (read-write): ${override.executor}`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
				return;
			}

			if (sub === "reset") {
				pi.appendEntry(PAIR_OVERRIDE_ENTRY, null);
				if (preset) {
					liveState = {
						...liveState,
						planner: preset.planner,
						executor: preset.executor,
					};
				}
				updateStatusWidget(ctx, preset);
				ctx.ui.notify("Orchestrator pair reset to preset defaults.", "info");
				return;
			}

			if (sub === "plan" || sub === "execute") {
				liveState = {
					...liveState,
					phase: sub,
					stepsSinceHandoff: 0,
					handbackPending: false,
				};
				pi.sendMessage(
					{
						customType: PHASE_OVERRIDE_MESSAGE,
						content: `[Orchestrator phase manually switched to ${sub.toUpperCase()}]`,
						display: true,
						details: { phase: sub },
					},
					{ deliverAs: "nextTurn" },
				);
				updateStatusWidget(ctx, preset);
				ctx.ui.notify(`Orchestrator phase forced to: ${sub.toUpperCase()}`, "info");
				return;
			}

			const aliasList = Object.entries(config.aliases ?? {})
				.map(([k, v]) => `${k} -> ${shortModelLabel(v)}`)
				.join(", ");
			const statusLines = [
				`Active Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"} (${preset ? "Orchestrator enabled" : "Standard model"})`,
				`Phase: ${liveState.phase.toUpperCase()} | Steps since handoff: ${liveState.stepsSinceHandoff}/${preset?.reviewEvery ?? reviewEvery} | Review pending: ${liveState.handbackPending}`,
				`Planner (read-only): ${liveState.planner}`,
				`Executor (read-write): ${liveState.executor}`,
				`Shortcuts: /orchestrator pair <planner> <executor> | /orchestrator reset | /orchestrator plan | /orchestrator execute | /orchestrator init`,
				`Aliases: ${aliasList}`,
			];
			ctx.ui.notify(statusLines.join("\n"), "info");
		},
	});
}
