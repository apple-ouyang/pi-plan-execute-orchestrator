/**
 * Pure state-machine and tool-gate helpers for pi-plan-execute-orchestrator.
 * Kept dependency-free so `node --test` can verify all state transitions directly.
 */

export const PHASE_OVERRIDE_MESSAGE = "orchestrator-phase-override";

export interface PhaseSnapshot {
	phase: "plan" | "execute";
	stepsSinceHandoff: number;
	handbackPending: boolean;
}

export interface TranscriptMessageLike {
	role?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	details?: { phase?: "plan" | "execute" };
}

/** Mutating bash patterns blocked while in read-only Plan mode. */
const MUTATING_BASH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{
		pattern:
			/(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|rmdir|trash|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|patch)\b/,
		label: "filesystem mutation",
	},
	{ pattern: /(?:^|[;&|]\s*)tee\b/, label: "tee file write" },
	{ pattern: /\bsed\s+(?:-[a-zA-Z]*i|--in-place)\b/, label: "sed in-place edit" },
	{ pattern: /\bperl\s+-[a-zA-Z]*i\b/, label: "perl in-place edit" },
	{
		pattern:
			/(?:^|[;&|]\s*)(?:env\s+[^;&|]*\s+)?git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|restore|stash|cherry-pick|revert|tag|init|clone|clean|worktree\s+(?:add|remove|prune))\b/,
		label: "git state modification",
	},
	{
		pattern:
			/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun|pip|pip3|uv|brew|cargo)\s+(?:install|add|remove|uninstall|update|upgrade|ci|link|publish)\b/,
		label: "package modification",
	},
];

export function checkBashMutation(command: string): string | undefined {
	for (const { pattern, label } of MUTATING_BASH_PATTERNS) {
		if (pattern.test(command)) return label;
	}
	// Strip safe standard fd redirections like 2>/dev/null, >/dev/null, 2>&1, >&2 before checking file redirections
	const stripped = command
		.replace(/\b\d*>\s*\/dev\/null\b/g, "")
		.replace(/\b\d*>&\d+\b/g, "");
	if (/(?:^|[^<>=])>>?(?!=)\s*\S+/.test(stripped)) {
		return "shell output redirection to file";
	}
	return undefined;
}

/**
 * Pure function that derives the current orchestrator phase and step count
 * from the conversation messages since the latest user message.
 */
export function computeTranscriptState(
	messages: readonly TranscriptMessageLike[],
	reviewEvery: number,
): PhaseSnapshot {
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	if (lastUserIdx === -1) {
		return { phase: "plan", stepsSinceHandoff: 0, handbackPending: false };
	}

	let phase: "plan" | "execute" = "plan";
	let stepsSinceHandoff = 0;

	for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
		const m = messages[i];

		if (m.customType === PHASE_OVERRIDE_MESSAGE && m.details?.phase) {
			phase = m.details.phase;
			stepsSinceHandoff = 0;
			continue;
		}

		if (m.role === "assistant" && phase === "execute") {
			stepsSinceHandoff += 1;
			continue;
		}

		if (m.role === "toolResult" && !m.isError) {
			if (m.toolName === "exit_plan_mode") {
				phase = "execute";
				stepsSinceHandoff = 0;
			} else if (m.toolName === "enter_plan_mode") {
				phase = "plan";
				stepsSinceHandoff = 0;
			}
		}
	}

	const handbackPending =
		phase === "execute" && stepsSinceHandoff > 0 && stepsSinceHandoff % reviewEvery === 0;

	return { phase, stepsSinceHandoff, handbackPending };
}

export function splitModelSpec(spec: string, defaultProvider: string): { provider: string; modelId: string } {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		return { provider: defaultProvider, modelId: trimmed };
	}
	const first = trimmed.slice(0, slash);
	const rest = trimmed.slice(slash + 1);
	// Handle gateway group prefixes like "auto/deepseek-flash" where the prefix is part of modelId
	if (
		first === "auto" ||
		first === "group" ||
		first === "codex" ||
		first === "workbuddy" ||
		first === "apikey-fun" ||
		first === "refuseless"
	) {
		return { provider: defaultProvider, modelId: trimmed };
	}
	return { provider: first, modelId: rest };
}

export function shortModelLabel(spec: string): string {
	return spec
		.replace(/^magpie\//, "")
		.replace(/^(?:auto|group|codex|workbuddy)\//, "");
}
