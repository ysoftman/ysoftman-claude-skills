import type { ClassicHookInputs, EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";
import type {
	AgentRow,
	Alert,
	BackgroundTask,
	CommandRun,
	Commit,
	RepoState,
	SessionCron,
	SkillRun,
	TurnMark,
	WorkItem,
} from "../types";
import { clip, cut, firstLine, newTokens, short, totalTokens } from "./format";
import { clampHistory, HISTORY_MAX, HISTORY_ROWS } from "./history";
import { paneView } from "./pane";
import { readPullRequest } from "./pr";
import {
	newRain,
	RAIN,
	RAIN_MS,
	RAIN_ROWS,
	rainCells,
	rainMessage,
	rainSpeed,
} from "./rain";
import {
	end,
	isBusy,
	isLive,
	isOpenRun,
	RUN_END,
	STATUS,
	sync,
	TURN_END,
} from "./status";
import { PANE, RECENT_SHOWN, SHOWN } from "./theme";

const agents = atom({ plugin: "summary", key: "agents" } as const, []);

const now = atom({ plugin: "summary", key: "now" } as const, 0);

const recent = atom({ plugin: "summary", key: "recent" } as const, []);

const dirty = atom({ plugin: "summary", key: "dirty" } as const, 0);

const alerts = atom({ plugin: "summary", key: "alerts" } as const, []);

const skillRuns = atom({ plugin: "summary", key: "runs" } as const, []);

const mainModel = atom({ plugin: "summary", key: "model" } as const, "");

const paneShown = atom({ plugin: "summary", key: "shown" } as const, false);

const chord = atom({ plugin: "summary", key: "chord" } as const, "");

const tabs = atom({ plugin: "summary", key: "tabs" } as const, "");

// a reload raises session.start again, so the pane opens on its own only once
const autoOpened = atom(
	{ plugin: "summary", key: "autoOpened" } as const,
	false,
);

// when the main turn in progress began; 0 while Claude is idle
const working = atom({ plugin: "summary", key: "working" } as const, 0);

// background work and session crons as the last stop reported them
const tasks = atom({ plugin: "summary", key: "tasks" } as const, []);

const crons = atom({ plugin: "summary", key: "crons" } as const, []);

const turns = atom({ plugin: "summary", key: "turns" } as const, []);

const repo = atom({ plugin: "summary", key: "repo" } as const, {
	ahead: 0,
	behind: 0,
	commits: [],
});

const pullRequest = atom({ plugin: "summary", key: "pr" } as const, null);

// the Bash commands Claude and its subagents ran, newest first, and the first
// one shown
const commands = atom({ plugin: "summary", key: "commands" } as const, []);

const historyAt = atom({ plugin: "summary", key: "historyAt" } as const, 0);

const TURNS_MAX = 200;

// gh goes over the network, so the PR is read at most once a minute
const PR_MS = 60_000;

const PR_CHANGE = /\bgit\s+(?:-C\s+\S+\s+)?push\b|\bgh\s+pr\b/;

const line = (s: string) => cut(s.split("\n")[0] ?? "", 120);

// every line of a command on one row, so a multi-line one does not look cut
const oneRow = (s: string) =>
	cut(
		s
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.join(" ↵ "),
		200,
	);

const SUMMARY =
	"You write one-line entries for a log of finished work. Given what the user asked and the " +
	"coding assistant's final reply, say what the assistant did in at most 40 characters, in the " +
	"language of the reply, as a terse phrase. Describe the action taken, not the content it " +
	"reported. No quotes, no markdown, no trailing period.";

const patch = async (
	$: EngineInterface,
	id: string,
	fn: (a: AgentRow) => AgentRow | undefined,
) => {
	if ((await read($, agents)).some((a) => a.id === id && fn(a) !== undefined)) {
		await update($, agents, (list) =>
			list.map((a) => (a.id === id ? (fn(a) ?? a) : a)),
		);
	}
};

const summarize = async ($: EngineInterface, ask: string, answer: string) => {
	try {
		const done = await $.model.complete({
			model: "haiku",
			system: SUMMARY,
			prompt: `User asked:\n${ask}\n\nAssistant replied:\n${answer}`,
			maxTokens: 60,
			timeoutMs: 20_000,
		});
		const line = done.isAnswered ? done.text.split("\n")[0]?.trim() : undefined;
		return line ? cut(line, 60) : firstLine(answer);
	} catch {
		return firstLine(answer);
	}
};

let prAt = Number.NEGATIVE_INFINITY;
let prBranch: string | undefined;
let prRun: Promise<unknown> = Promise.resolve();

// a checkout reads the new branch's PR without waiting
const refreshPr = (
	$: EngineInterface,
	root: string | undefined,
	force = false,
) => {
	const run = prRun.then(async () => {
		const { branch } = await read($, repo);
		const t = await $.clock.now();
		if (!force && branch === prBranch && t - prAt < PR_MS) {
			return;
		}
		prAt = t;
		prBranch = branch;
		const next =
			root === undefined || branch === undefined
				? null
				: await readPullRequest($, root, branch);
		if (JSON.stringify(next) !== JSON.stringify(await read($, pullRequest))) {
			await update($, pullRequest, () => next);
		}
	});
	prRun = run.catch(() => undefined);
	return prRun;
};

// "## main...origin/main [ahead 1, behind 2]", the head line of `status -b`,
// and the last commits: the first `ahead` of them are not pushed yet.
const refreshRepo = async ($: EngineInterface, root: string, head: string) => {
	const m =
		/^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(
			head,
		);
	const count = (word: string) =>
		Number(new RegExp(`${word} (\\d+)`).exec(m?.[3] ?? "")?.[1] ?? 0);
	const log = await $.process
		.run(
			[
				"git",
				"-C",
				root,
				"log",
				"-n",
				String(SHOWN),
				"--format=%h%x09%ct%x09%s",
			],
			{
				timeoutMs: 5_000,
			},
		)
		.catch(() => undefined);
	const commits: Commit[] =
		log?.exitCode === 0
			? log.stdout
					.split("\n")
					.map((l) => l.split("\t"))
					.filter((f) => f.length >= 3)
					.map(([hash = "", at = "0", ...subject]) => ({
						hash,
						at: Number(at) * 1000,
						subject: subject.join("\t"),
					}))
			: [];
	const next: RepoState = {
		...(m?.[1] === undefined ? {} : { branch: m[1] }),
		...(m?.[2] === undefined ? {} : { upstream: m[2] }),
		ahead: count("ahead"),
		behind: count("behind"),
		commits,
	};
	if (JSON.stringify(next) !== JSON.stringify(await read($, repo))) {
		await update($, repo, () => next);
	}
};

// One read at a time, so an older read cannot land after a newer one.
let reading: Promise<unknown> = Promise.resolve();

const refreshGit = ($: EngineInterface, root: string | undefined) => {
	const run = reading.then(() => readGit($, root));
	reading = run.catch(() => undefined);
	return run;
};

const readGit = async ($: EngineInterface, root: string | undefined) => {
	if (root === undefined) {
		return;
	}
	const run = await $.process
		.run(
			[
				"git",
				"-C",
				root,
				"status",
				"--porcelain=v1",
				"--branch",
				"--untracked-files=all",
			],
			{
				timeoutMs: 5_000,
			},
		)
		.catch(() => undefined);
	if (run === undefined || run.exitCode !== 0) {
		return;
	}
	const lines = run.stdout.split("\n");
	await refreshRepo($, root, lines[0]?.startsWith("## ") ? lines[0] : "");
	// one line a path, a rename's too
	const count = lines.filter(
		(l) => l.length > 3 && !l.startsWith("## "),
	).length;
	if ((await read($, dirty)) !== count) {
		await update($, dirty, () => count);
	}
};

const record = async (
	$: EngineInterface,
	tool: string,
	agentId: string | undefined,
	ran: { deny?: string; isError?: true; text?: string },
) => {
	const failed = ran.deny !== undefined || ran.isError === true;
	if (failed && tool !== "SubagentHandback") {
		const agent =
			agentId === undefined
				? undefined
				: (await read($, agents)).find((a) => a.id === agentId)?.label;
		const alert: Alert = {
			at: await $.clock.now(),
			tool,
			reason: cut(
				firstLine((ran.deny ?? ran.text ?? "").trim() || "error"),
				120,
			),
			...(agent === undefined ? {} : { agent }),
		};
		await update($, alerts, (list) => [alert, ...list].slice(0, SHOWN));
	}
};

const scrollHistory = async ($: EngineInterface, by: number) => {
	const at = await read($, historyAt);
	const next = clampHistory(at + by, (await read($, commands)).length);
	if (next !== at) {
		await update($, historyAt, () => next);
	}
};

// A new command goes on top. A list at its top follows the newest; one
// scrolled down keeps the rows in view where they are.
const startCommand = async ($: EngineInterface, run: CommandRun) => {
	await update($, commands, (list) =>
		[run, ...list.filter((c) => c.id !== run.id)].slice(0, HISTORY_MAX),
	);
	const at = await read($, historyAt);
	const next =
		at === 0 ? 0 : clampHistory(at + 1, (await read($, commands)).length);
	if (next !== at) {
		await update($, historyAt, () => next);
	}
};

const endCommand = async (
	$: EngineInterface,
	id: string,
	ran: { deny?: string; isError?: true },
	shell: string | undefined,
) => {
	if (!(await read($, commands)).some((c) => c.id === id)) {
		return;
	}
	const endedAt = await $.clock.now();
	const result: CommandRun["result"] =
		ran.deny !== undefined
			? "denied"
			: ran.isError === true
				? "failed"
				: shell === undefined
					? "ok"
					: "bg";
	await update($, commands, (list) =>
		list.map((c) =>
			c.id === id
				? { ...c, endedAt, result, ...(shell === undefined ? {} : { shell }) }
				: c,
		),
	);
};

// a background command's shell gone from the tasks list ended or was stopped
const endShells = async ($: EngineInterface) => {
	const running = new Set(
		(await read($, tasks))
			.filter((b) => b.status === "running")
			.map((b) => b.id),
	);
	const isOver = (c: CommandRun) =>
		c.shell !== undefined && !running.has(c.shell);
	if ((await read($, commands)).some(isOver)) {
		await update($, commands, (list) =>
			list.map(({ shell, ...c }) =>
				shell !== undefined && running.has(shell) ? { ...c, shell } : c,
			),
		);
	}
};

type StopInput = ClassicHookInputs["Stop"];

const syncBackground = async (
	$: EngineInterface,
	list: StopInput["background_tasks"] = [],
	scheduled: StopInput["session_crons"] = [],
) => {
	// subagents already have rows of their own, from agent.spawn
	const nextTasks: BackgroundTask[] = list
		.filter((b) => b.type !== "subagent" && b.agent_type === undefined)
		.map((b) => ({
			id: b.id,
			type: b.type,
			status: b.status,
			label: line(
				b.command ??
					(b.server === undefined
						? (b.name ?? b.description)
						: `${b.server} ${b.tool ?? ""}`),
			),
		}));
	const nextCrons: SessionCron[] = scheduled.map((c) => ({
		id: c.id,
		schedule: c.schedule,
		recurring: c.recurring,
		prompt: line(c.prompt),
	}));
	if (JSON.stringify(nextTasks) !== JSON.stringify(await read($, tasks))) {
		await update($, tasks, () => nextTasks);
	}
	if (JSON.stringify(nextCrons) !== JSON.stringify(await read($, crons))) {
		await update($, crons, () => nextCrons);
	}
	await endShells($);
};

const discover = async ($: EngineInterface, id: string, model: string) => {
	if ((await read($, agents)).some((a) => a.id === id)) {
		return;
	}
	const info = (await $.agent.list()).find((a) => a.id === id);
	if (info === undefined) {
		return;
	}
	const row: AgentRow = {
		id,
		label: clip(info.name ?? info.type),
		model: short(model),
		description: info.description,
		startedAt: await $.clock.now(),
		status: "running",
		listed: true,
		...(info.name === undefined ? {} : { name: info.name }),
	};
	await update($, agents, (list) =>
		list.some((a) => a.id === id) ? list : [...list, row],
	);
	await update($, now, () => row.startedAt);
};

const patchOpen = async ($: EngineInterface, fn: (r: SkillRun) => SkillRun) => {
	const last = (await read($, skillRuns)).at(-1);
	if (
		last !== undefined &&
		isOpenRun(last) &&
		JSON.stringify(fn(last)) !== JSON.stringify(last)
	) {
		await update($, skillRuns, (l) => [...l.slice(0, -1), fn(last)]);
	}
};

const openRun = async (
	$: EngineInterface,
	skills: string[],
	model: string,
	effort?: string,
) => {
	if (isOpenRun((await read($, skillRuns)).at(-1))) {
		await patchOpen($, (r) => ({ ...r, skills }));
		return;
	}
	const run: SkillRun = {
		skills,
		model,
		...(effort === undefined ? {} : { effort }),
		startedAt: await $.clock.now(),
	};
	await update($, skillRuns, (l) => [...l, run].slice(-SHOWN));
};

const isPaneShown = async ($: EngineInterface) =>
	(await $.ui.panes()).some((p) => p.id === PANE && p.isShown);

const setShown = async ($: EngineInterface, isShown: boolean) => {
	if ((await read($, paneShown)) !== isShown) {
		await update($, paneShown, () => isShown);
	}
};

const syncChord = async ($: EngineInterface) => {
	const bound = await boundKeys($);
	const keyOf = (action: string) =>
		bound.find(([, a]) => a === action)?.[0] ?? "";
	const key = keyOf(`command:${PANE}`);
	if ((await read($, chord)) !== key) {
		await update($, chord, () => key);
	}
	const tabKeys = [keyOf("pane:previous"), keyOf("pane:next")]
		.filter(Boolean)
		.join(" ");
	if ((await read($, tabs)) !== tabKeys) {
		await update($, tabs, () => tabKeys);
	}
	return key;
};

// Shown: close. Open behind another pane's tab: the engine only retitles an
// open id, while a newly opened pane becomes the shown tab, so reopen it.
const toggle = async ($: EngineInterface, root: string | undefined) => {
	const pane = (await $.ui.panes()).find((p) => p.id === PANE);
	if (pane?.isShown) {
		await $.ui.close({ id: PANE });
		await setShown($, false);
		return false;
	}
	if (pane !== undefined) {
		await $.ui.close({ id: PANE });
	}
	await $.ui.open({ id: PANE, title: "summary", columns: 60 });
	await setShown($, true);
	await syncChord($);
	await refreshGit($, root);
	return true;
};

const hintOf = (key: string) => key || `/${PANE}`;

const usage = (key: string, tabKeys: string) =>
	[
		`/${PANE}  open or close the summary pane${key === "" ? "" : ` (${key})`}`,
		`/${PANE} help  this help`,
		...(tabKeys === "" ? [] : [`${tabKeys}  previous/next pane tab`]),
		...(key !== "" && tabKeys !== ""
			? []
			: [
					"",
					'Shortcuts are not registered by the mod. Ask Claude "set up shortcuts per the summary mod README",',
					"or add them to ~/.claude/keybindings.json yourself, merging into the existing blocks:",
					...(key === ""
						? [
								`  "Chat":   "ctrl+x s": "command:${PANE}"   open/close the pane`,
							]
						: []),
					...(tabKeys === ""
						? [
								'  "Global": "ctrl+<": "pane:previous", "ctrl+>": "pane:next"   pane tabs',
								'            also "ctrl+shift+," / "ctrl+shift+." if your terminal sends those',
							]
						: []),
					"Any other key works too; the hints follow the key you bind.",
				]),
	].join("\n");

const boundKeys = async ($: EngineInterface) => {
	try {
		const { bindings = [] } = JSON.parse(
			await $.fs.read(`${await $.env.get("HOME")}/.claude/keybindings.json`),
		) as {
			bindings?: { context?: string; bindings?: Record<string, unknown> }[];
		};
		return bindings.flatMap((b) => Object.entries(b.bindings ?? {}));
	} catch {
		return [];
	}
};

// a teammate (--agent-id) or an agent started in a side pane (--agent <name>),
// not --agents, which only defines agents for the session
const isSideAgent = async ($: EngineInterface) =>
	/\s--agent(-id)?[\s=]/.test(
		(
			await $.process
				.run(["sh", "-c", "ps -o args= -p $PPID"], { timeoutMs: 5_000 })
				.catch(() => undefined)
		)?.stdout ?? "",
	);

export const register: Register = (on) => {
	let loaded: string[] = [];
	let worked = false;
	let ask = "";
	let draining = false;
	let tick = 0;
	let root: string | undefined;
	const rain = newRain();
	// the tokens the last main model call took
	let stepTokens = 0;
	// The hint line's isWorking, the engine's own word on a running turn;
	// undefined until the line draws after a (re)load.
	let hintWorking: boolean | undefined;
	// the pane window's first tree row as last drawn
	let paneTop = 0;
	// the commands list's first row in the tree as the pane last drew it
	let historyTop: number | undefined;

	on("session.start", async ($, e, next) => {
		const key = await syncChord($);
		const top = await $.process
			.run(["git", "rev-parse", "--show-toplevel"], { timeoutMs: 5_000 })
			.catch(() => undefined);
		root = top?.exitCode === 0 ? top.stdout.trim() : undefined;
		await refreshGit($, root);
		void refreshPr($, root);
		if (e.isInteractive && !(await read($, autoOpened))) {
			await update($, autoOpened, () => true);
			if (!(await isSideAgent($))) {
				await $.ui.open({ id: PANE, title: "summary", columns: 60 });
			}
		}
		await setShown($, await isPaneShown($));
		$.clock.every(100, async () => {
			// a render hook only reads, so the hint line's word lands here
			if (
				hintWorking !== undefined &&
				hintWorking !== (await read($, working)) > 0
			) {
				const t = await $.clock.now();
				await update($, working, () => (hintWorking ? t : 0));
			}
			// a click on another pane's tab hides this one without an event
			await setShown($, await isPaneShown($));
			if (!(await read($, paneShown))) {
				return;
			}
			tick++;
			const list = await read($, agents);
			const busy = isBusy(
				list,
				await read($, skillRuns),
				await read($, recent),
			);
			const since = await read($, working);
			const running = list.filter((a) => a.status === "running");
			rain.pace = rainSpeed(
				[
					...(since > 0 ? [await read($, mainModel)] : []),
					...running.map((a) => a.model),
				],
				running.length,
				stepTokens,
			);
			// a turn alone redraws once a second for its elapsed time
			if (busy || tick % (since > 0 ? 10 : 100) === 0) {
				$.ui.invalidate("ui.render");
			}
		});
		// The rain repaints its Raster in place: a redraw of the whole pane folds
		// to one per 100 ms, a blit runs at the surface's frame rate.
		$.clock.every(RAIN_MS, async () => {
			if (rain.columns === 0 || !(await read($, paneShown))) {
				return;
			}
			const now = await $.clock.now();
			rain.t += Math.min(now - rain.at, 1000) * rain.pace;
			rain.at = now;
			// idle, the rain clock stands still and only the message moves
			if (rain.pace === 0) {
				if (!rain.wasIdle) {
					rain.wasIdle = true;
					rain.idleSince = now;
				}
				const message = rainMessage(rain.columns, rain.idleSince, now);
				if (message === rain.lastMessage) {
					return;
				}
				rain.lastMessage = message;
				await $.ui
					.blit({
						requestId: PANE,
						key: RAIN,
						cells: rainCells(rain.t, rain.columns, RAIN_ROWS, message),
					})
					.catch(() => undefined);
				return;
			}
			rain.wasIdle = false;
			rain.lastMessage = "";
			await $.ui
				.blit({
					requestId: PANE,
					key: RAIN,
					cells: rainCells(rain.t, rain.columns, RAIN_ROWS),
				})
				.catch(() => undefined);
		});
		$.clock.every(1500, async () => {
			const item = (await read($, recent)).find((w) => w.text === undefined);
			if (draining || item === undefined) {
				return;
			}
			draining = true;
			try {
				const text = await summarize($, item.ask ?? "", item.answer ?? "");
				await update($, recent, (list) =>
					list.map(({ ask: _ask, answer: _answer, ...w }) =>
						w.id === item.id ? { ...w, text } : w,
					),
				);
			} finally {
				draining = false;
			}
		});
		// commits and pushes from another terminal show up too
		$.clock.every(15_000, async () => {
			if (await read($, paneShown)) {
				await refreshGit($, root);
			}
		});
		$.clock.every(1000, async () => {
			const rows = await read($, agents);
			if (!rows.some(isLive)) {
				return;
			}
			const t = await $.clock.now();
			const live = new Map(
				(await $.agent.list()).map((a) => [a.id, STATUS[a.status]]),
			);
			if (rows.some((a) => sync(a, live.get(a.id), t) !== a)) {
				await update($, agents, (list) =>
					list.map((a) => sync(a, live.get(a.id), t)),
				);
			}
			if ((await read($, agents)).some((a) => a.status === "running")) {
				await update($, now, () => t);
			}
		});

		await $.command.register({
			name: PANE,
			description: `Open or close the summary pane${key === "" ? "" : ` (${key})`} · help: usage`,
			argumentHint: "[help]",
			immediate: true,
		});

		return next(e);
	});

	on("agent.spawn", async ($, e, next) => {
		const ran = await next(e);
		if (ran.agentId === undefined) {
			return ran;
		}
		const row: AgentRow = {
			id: ran.agentId,
			label: clip(e.name ?? e.subagentType),
			model: short(ran.model),
			description: e.description,
			startedAt: await $.clock.now(),
			status: "running",
			...(e.name === undefined ? {} : { name: e.name }),
		};
		await update($, agents, (list) => [
			...list.filter((a) => a.id !== row.id),
			row,
		]);
		await update($, now, () => row.startedAt);

		return ran;
	}).catch((_, e, next) => next(e));

	on("turn.step", async function* ($, e, next) {
		if (e.agentId !== undefined) {
			await discover($, e.agentId, e.model);
			return yield* next(e);
		}
		const effort = e.effort === undefined ? undefined : String(e.effort);
		if (loaded.length > 0) {
			await openRun($, [...loaded], short(e.model), effort);
		}
		const step = yield* next(e);
		if (step.usage !== null) {
			stepTokens = totalTokens(step.usage);
		}
		const answered = short(step.usage?.model ?? e.model);
		if (loaded.length > 0) {
			await patchOpen($, (r) => ({ ...r, model: answered }));
		}
		const tag = [answered, effort].filter((v) => v !== undefined).join(" · ");
		if ((await read($, mainModel)) !== tag) {
			await update($, mainModel, () => tag);
		}

		return step;
	});

	on("tool.call", { tool: "Skill" }, async (_, e, next) => {
		const ran = await next(e);
		if (
			e.agentId === undefined &&
			ran.deny === undefined &&
			ran.isError !== true
		) {
			loaded = [...new Set([...loaded, e.skill])];
		}

		return ran;
	}).catch((_, e, next) => next(e));

	on("tool.call", async ($, e, next) => {
		const tool = String(e.tool);
		const id = e.agentId;
		worked ||= id === undefined;
		const [, ran] = await Promise.all([
			id === undefined || tool === "SubagentHandback"
				? undefined
				: patch($, id, (a) =>
						a.status === "running" && a.tool === tool
							? undefined
							: { ...a, status: "running", tool },
					),
			next(e),
		]);
		await record($, tool, id, ran);

		return ran;
	}).catch((_, e, next) => next(e));

	// every command goes to the history, a subagent's under its label; a shell
	// left running shows at once
	on("tool.call", { tool: "Bash" }, async ($, e, next) => {
		const id = e.agentId;
		await startCommand($, {
			id: e.tool_use_id,
			command: oneRow(e.command),
			...(id === undefined
				? {}
				: {
						agent:
							(await read($, agents)).find((a) => a.id === id)?.label ??
							id.slice(0, 8),
					}),
			startedAt: await $.clock.now(),
		});
		const ran = await next(e);
		const shell =
			ran.isError === true ? undefined : ran.result?.backgroundTaskId;
		await endCommand($, e.tool_use_id, ran, shell);
		if (shell !== undefined) {
			const row: BackgroundTask = {
				id: shell,
				type: "shell",
				status: "running",
				label: line(e.command),
			};
			await update($, tasks, (list) =>
				list.some((b) => b.id === shell) ? list : [...list, row],
			);
		}
		if (ran.deny === undefined && PR_CHANGE.test(e.command)) {
			void refreshPr($, root, true);
		}

		return ran;
	}).catch((_, e, next) => next(e));

	on("tool.call", { tool: "TaskStop" }, async ($, e, next) => {
		const ran = await next(e);
		const task = e.task_id ?? e.shell_id;
		if (ran.deny !== undefined || ran.isError === true || task === undefined) {
			return ran;
		}
		const t = await $.clock.now();
		if ((await read($, tasks)).some((b) => b.id === task)) {
			await update($, tasks, (list) => list.filter((b) => b.id !== task));
			await endShells($);
		}
		const hit = (a: AgentRow) =>
			a.status !== "killed" && (a.id === task || a.name === task);
		if ((await read($, agents)).some(hit)) {
			await update($, agents, (list) =>
				list.map((a) =>
					hit(a) ? { ...a, status: "killed", endedAt: end(a, t) } : a,
				),
			);
		}

		return ran;
	}).catch((_, e, next) => next(e));

	on("turn.complete", async ($, e, next) => {
		const id = e.agentId;
		if (id !== undefined && !(await $.agent.list()).some((a) => a.id === id)) {
			const endedAt = await $.clock.now();
			await patch($, id, (a) =>
				isLive(a) && !a.listed
					? { ...a, status: TURN_END[e.reason], endedAt }
					: undefined,
			);
		}
		if (id !== undefined) {
			await refreshGit($, root);
		}
		if (id === undefined) {
			const mark: TurnMark = { ms: e.durationMs, ok: e.reason === "answer" };
			await update($, turns, (list) => [...list, mark].slice(-TURNS_MAX));
			if (loaded.length > 0) {
				const endedAt = await $.clock.now();
				await patchOpen($, (r) => ({
					...r,
					endedAt,
					result: RUN_END[e.reason],
				}));
				loaded = [];
			}
			if (worked && e.reason === "answer" && e.answer.trim() !== "") {
				const item: WorkItem = {
					id: e.turnId,
					at: await $.clock.now(),
					durationMs: e.durationMs,
					...(e.usage === undefined ? {} : { tokens: newTokens(e.usage) }),
					ask,
					answer: e.answer.slice(0, 4000),
				};
				await update($, recent, (list) =>
					[item, ...list.filter((w) => w.id !== item.id)].slice(
						0,
						RECENT_SHOWN,
					),
				);
			}
			if (worked) {
				await refreshGit($, root);
			}
			worked = false;
		}
		void refreshPr($, root);

		return next(e);
	});

	// A stop carries the session's background work and crons; a finished task
	// or a fired cron wakes the session, so the next stop brings the change.
	on("classic.Stop", async ($, e, next) => {
		await syncBackground($, e.background_tasks, e.session_crons);
		return next(e);
	}).catch((_, e, next) => next(e));

	on("classic.SubagentStop", async ($, e, next) => {
		await syncBackground($, e.background_tasks, e.session_crons);
		return next(e);
	}).catch((_, e, next) => next(e));

	on("prompt.submit", async ($, e, next) => {
		if (e.turnId === undefined) {
			ask = e.text.slice(0, 1000);
			const name = /^\/([\w:.-]+)(?=\s|$)/.exec(e.text)?.[1];
			const isCommand =
				name !== undefined &&
				(await $.command.list()).some((c) => c.name === name);
			loaded = isCommand ? [name] : [];
		}
		if (e.origin.kind === "composer" || e.origin.kind === "bridge") {
			await update($, agents, (list) => list.filter(isLive));
			if ((await read($, alerts)).length > 0) {
				await update($, alerts, () => []);
			}
		}

		return next(e);
	}).catch((_, e, next) => next(e));

	on("command.run", { command: PANE }, async ($, e) => {
		if (e.args.trim() === "help") {
			return { text: usage(await syncChord($), await read($, tabs)) };
		}
		// no text, so a "command:summary" shortcut leaves nothing in the transcript
		await toggle($, root);
		return {};
	}).catch((_, e, next) => next(e));

	on("ui.close", { id: PANE }, async ($, e, next) => {
		const closed = await next(e);
		await setShown($, false);

		return closed;
	}).catch((_, e, next) => next(e));

	// A wheel tick over the command list, where the pane last drew it, scrolls
	// the list and keeps the pane window where it is; anywhere else, or with
	// nothing to scroll, the pane moves.
	on(
		"ui.scroll",
		{ component: "Pane", requestId: PANE },
		async ($, e, next) => {
			const count = (await read($, commands)).length;
			if (
				e.pointer === undefined ||
				historyTop === undefined ||
				count <= HISTORY_ROWS
			) {
				return next(e);
			}
			// the window's row now: e.offset less e.by, unless clamped at an edge
			const last = Math.max(0, e.contentRows - e.bodyRows);
			const top = e.offset > 0 && e.offset < last ? e.offset - e.by : paneTop;
			const row = top + e.pointer.row - historyTop;
			if (row < 0 || row >= HISTORY_ROWS) {
				return next(e);
			}
			await scrollHistory($, e.by);

			return {};
		},
	).catch((_, e, next) => next(e));

	// The hint under the prompt carries the toggle hint as dim tail text, so the
	// band above the prompt stays free.
	on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
		hintWorking = e.props.isWorking;
		if (await read($, paneShown)) {
			return next(e);
		}
		const key = await read($, chord);
		const tail = [e.props.tail, key === "" ? `/${PANE}` : `${key} ${PANE}`]
			.filter(Boolean)
			.join(" · ");
		return next({ ...e, props: { ...e.props, tail } });
	});

	on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
		paneTop = e.props.scroll.offset;
		return paneView({
			e,
			els: $.ui.resolve(e),
			t: await $.clock.now(),
			root,
			rain,
			hint: hintOf(await read($, chord)),
			tabKeys: await read($, tabs),
			onToggle: () => toggle($, root),
			list: await read($, agents),
			runs: await read($, skillRuns),
			work: await read($, recent),
			uncommitted: await read($, dirty),
			git: await read($, repo),
			pr: await read($, pullRequest),
			warnings: await read($, alerts),
			tag: await read($, mainModel),
			since: await read($, working),
			scheduled: await read($, crons),
			marks: await read($, turns),
			commands: await read($, commands),
			historyAt: await read($, historyAt),
			onHistoryScroll: (by) => scrollHistory($, by),
			onHistoryTop: (row) => {
				historyTop = row;
			},
		});
	});
};
