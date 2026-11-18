import type { ModelUsage } from "claude-code";
import type { RtkGain } from "../types";

export const totalTokens = (u: ModelUsage) =>
	u.input_tokens +
	u.output_tokens +
	u.cache_read_input_tokens +
	u.cache_creation_input_tokens;

// what a turn took in and wrote, leaving out what the prompt cache served
export const newTokens = (u: ModelUsage) =>
	u.input_tokens + u.output_tokens + u.cache_creation_input_tokens;

export const LABEL_MAX = 20;

export const elapsed = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60
		? `${s}s`
		: `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

export const clip = (s: string) =>
	s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s;

export const cut = (s: string, n: number) =>
	s.length > n ? `${s.slice(0, n - 1)}…` : s;

export const firstLine = (answer: string) =>
	cut(
		answer
			.split("\n")
			.map((l) =>
				l
					.replace(/^[#>*\-\s]+/, "")
					.replace(/[*`]/g, "")
					.trim(),
			)
			.find((l) => l !== "") ?? "done",
		60,
	);

export const ago = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60
		? `${s}s`
		: s < 3600
			? `${Math.floor(s / 60)}m`
			: `${Math.floor(s / 3600)}h`;
};

export const kilo = (n: number) =>
	n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`;

// characters a terminal draws two cells wide: Hangul, CJK, emoji
const WIDE =
	/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\u{1f300}-\u{1faff}]/gu;

// the cells a line takes on a terminal
export const cells = (s: string) => s.replace(WIDE, "  ").length;

// s in lines of at most w cells: broken at spaces, a word wider than a line
// cut by cells; one line at least
export const wrap = (s: string, w: number) => {
	const width = Math.max(1, w);
	const lines: string[] = [];
	let line = "";
	for (const word of s.split(" ").filter((x) => x !== "")) {
		const joined = line === "" ? word : `${line} ${word}`;
		if (cells(joined) <= width) {
			line = joined;
			continue;
		}
		if (line !== "") {
			lines.push(line);
		}
		line = "";
		for (const ch of word) {
			if (line !== "" && cells(line + ch) > width) {
				lines.push(line);
				line = "";
			}
			line += ch;
		}
	}
	return [...lines, line];
};

export const short = (model: string) => model.replace(/^.*claude-/, "");

// mcp__<server>__<tool> as [server, tool], plugin_ and claude_ai_ prefixes off
export const mcpName = (name: string): [string, string] | undefined => {
	const m = /^mcp__(.+?)__(.+)$/.exec(name);
	return m?.[1] === undefined || m[2] === undefined
		? undefined
		: [
				m[1]
					.replace(/^claude_ai_/, "")
					.replace(/^plugin_(.+)_\1$/, "$1")
					.replace(/^plugin_/, ""),
				m[2],
			];
};

// `rtk gain -f json` as its summary's savings; undefined when it is not that
export const rtkGain = (stdout: string): RtkGain | undefined => {
	try {
		const s = (JSON.parse(stdout) as { summary?: Record<string, unknown> })
			.summary;
		const saved = s?.total_saved;
		const pct = s?.avg_savings_pct;
		const commands = s?.total_commands;
		return typeof saved === "number" &&
			typeof pct === "number" &&
			typeof commands === "number"
			? { saved, pct, commands }
			: undefined;
	} catch {
		return undefined;
	}
};
