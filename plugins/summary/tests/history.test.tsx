import type { On } from "claude-code";
import type { Engine } from "claude-code/testing";
import { expect, mock, test } from "claude-code/testing";
import { cells } from "../hooks/format";
import {
	clampHistory,
	fit,
	HISTORY_MAX,
	HISTORY_ROWS,
	historyBox,
} from "../hooks/history";
import { C } from "../hooks/theme";
import type { CommandRun } from "../types";

const PANE = {
	component: "Pane",
	requestId: "summary",
	props: {
		title: "summary",
		isFocused: false,
		bodyColumns: 100,
		placement: "dock",
		scroll: { offset: 0, bodyRows: 40 },
		view: {},
	},
} as const;

const setup = ($: Engine, on: On) => {
	const clock = mock.clock(on, { now: 1_000_000 });
	const state: Record<string, unknown> = {};
	on("state.set", (_, e, next) => {
		state[e.key] = e.value;
		return next(e);
	});
	// "sleep N" runs N seconds, "false" fails, "rm -rf /" is refused, one run in
	// the background leaves shell "bg-<command>"
	on("tool.call", { tool: "Bash" }, async (_, e) => {
		const sleep = /^sleep (\d+)/.exec(e.command)?.[1];
		if (sleep !== undefined) {
			await clock.sleep(Number(sleep) * 1000);
		}
		if (e.command === "false") {
			return { isError: true as const, result: null, text: "exit 1" };
		}
		if (e.command === "rm -rf /") {
			return { deny: "not allowed" };
		}
		return {
			result: {
				stdout: "",
				stderr: "",
				interrupted: false,
				...(e.run_in_background === true
					? { backgroundTaskId: `bg-${e.command}` }
					: {}),
			},
		};
	});
	on("tool.call", { tool: "TaskStop" }, () => ({ result: "stopped" }) as never);
	on("classic.Stop", () => ({}));
	on("agent.spawn", () => ({ model: "claude-sonnet-5-5", agentId: "a1" }));
	// the engine beneath: the pane window moves to e.offset
	const moves: number[] = [];
	on("ui.scroll", (_, e) => {
		moves.push(e.offset);
		return {};
	});

	// the engine's own call site carries agentId; the kit's $.tool.call types leave it out
	const bash = (command: string, agentId?: string, extra: object = {}) =>
		$.tool.call({
			tool: "Bash",
			command,
			...(agentId === undefined ? {} : { agentId }),
			...extra,
		} as never);
	// agent a1, labeled by its name or its type
	const spawn = (subagentType: string, name?: string) =>
		$.agent.spawn({
			tool_use_id: "tu-spawn",
			prompt: "do it",
			description: "check",
			subagentType,
			...(name === undefined ? {} : { name }),
			provider: { plugin: "engine", tier: "core" },
			parentModel: "claude-opus-5-5",
			background: true,
			fork: false,
		});
	// a wheel tick over the pane body's row `row`, the window at `offset`
	const wheel = (
		row: number | undefined,
		by: number,
		view = { offset: 0, contentRows: 40, bodyRows: 40 },
	) =>
		$.ui.scroll({
			component: "Pane",
			requestId: "summary",
			offset: Math.min(
				Math.max(0, view.offset + by),
				Math.max(0, view.contentRows - view.bodyRows),
			),
			by,
			bodyRows: view.bodyRows,
			contentRows: view.contentRows,
			origin: { kind: "person" },
			...(row === undefined ? {} : { pointer: { column: 5, row } }),
		});
	const commands = () => (state.commands ?? []) as CommandRun[];
	const offset = () => (state.historyAt ?? 0) as number;
	const pane = (surface: "terminal" | "desktop", bodyColumns = 100) =>
		$.ui.mount({
			plugin: "summary",
			surface,
			...PANE,
			props: { ...PANE.props, bodyColumns },
		});
	// the pane drawn once, where the wheel then finds the list
	const draw = async (bodyColumns = 100) => {
		const ui = await pane("terminal", bodyColumns);
		await ui.unmount();
	};

	return {
		clock,
		bash,
		spawn,
		wheel,
		moves,
		commands,
		offset,
		pane,
		draw,
	};
};

type Drawn = {
	type: string;
	props?: Record<string, unknown>;
	children?: (Drawn | string)[];
};

const textOf = (n: Drawn | string): string =>
	typeof n === "string" ? n : (n.children ?? []).map(textOf).join("");

// what each child of the pane's root holds, top to bottom
const labelOf = (n: Drawn) => {
	const s = textOf(n);
	return s.startsWith("SUMMARY")
		? "header"
		: /^━+$/.test(s)
			? "rule"
			: (/^(alerts|commands|recent)/.exec(s)?.[1] ?? "other");
};

// a framed box in the tree whose text starts with `title`
const boxOf = (n: Drawn | string, title: string): Drawn | undefined =>
	typeof n === "string"
		? undefined
		: n.props?.borderStyle !== undefined && textOf(n).startsWith(title)
			? n
			: (n.children ?? []).reduce<Drawn | undefined>(
					(found, c) => found ?? boxOf(c, title),
					undefined,
				);

// the pane's root children and its commands box's list rows
const drawnPane = async (ui: { drawn: () => Promise<unknown> }) => {
	const root = (await ui.drawn()) as Drawn;
	const nodes = (root.children ?? []).filter(
		(c): c is Drawn => typeof c !== "string",
	);
	const box = boxOf(root, "commands");
	return {
		nodes,
		box,
		labels: nodes.map(labelOf),
		// the title row first, then the list
		rows: (box?.children ?? []).slice(1).map(textOf),
	};
};

// The list's first row with recent of no work above it: the header and the
// rule, recent's four rows (borders, title, "no finished work yet"), then the
// commands box's top border and title.
const LIST_TOP = 2 + 4 + 2;

// two commands more than the box shows: its first row goes from 0 to 2
const MORE = HISTORY_ROWS + 2;

test("records every Bash command, newest first, with how each ended", async ($, on) => {
	const { clock, bash, commands } = setup($, on);

	const running = bash("sleep 2\n  echo done\n");
	await clock.settle();
	// a multi-line command keeps every line on its one row
	expect(commands()).toMatchObject([{ command: "sleep 2 ↵ echo done" }]);
	expect(commands()[0]?.result).toBeUndefined();
	await clock.advance(2_000);
	await running;
	await bash("false");
	await bash("rm -rf /");

	expect(commands()).toMatchObject([
		{ command: "rm -rf /", result: "denied" },
		{ command: "false", result: "failed" },
		{
			command: "sleep 2 ↵ echo done",
			result: "ok",
			startedAt: 1_000_000,
			endedAt: 1_002_000,
		},
	]);
	expect(commands().some((c) => c.agent !== undefined)).toBe(false);
});

test("a subagent's command carries its label, the main agent's none", async ($, on) => {
	const { bash, spawn, commands, pane } = setup($, on);
	await spawn("reviewer");
	await bash("npm test", "a1");
	// an agent the pane has no row for goes by its id's head
	await bash("ls", "f1e2d3c4b5a6");
	await bash("pwd");

	expect(commands()).toMatchObject([
		{ command: "pwd" },
		{ command: "ls", agent: "f1e2d3c4" },
		{ command: "npm test", agent: "reviewer" },
	]);
	expect(commands()[0]?.agent).toBeUndefined();
	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await pane(surface);
		expect((await drawnPane(ui)).rows).toEqual([
			"✓ pwd  0s",
			"✓ ls @f1e2d3c4  0s",
			"✓ npm test @reviewer  0s",
		]);
		await ui.unmount();
	}
});

test("keeps the last ten commands", async ($, on) => {
	const { bash, commands } = setup($, on);

	for (let i = 0; i < HISTORY_MAX + 2; i++) {
		await bash(`echo ${i}`);
	}

	expect(commands()).toHaveLength(HISTORY_MAX);
	expect(commands()[0]?.command).toBe("echo 11");
	expect(commands().at(-1)?.command).toBe("echo 2");
});

test("a wheel over the list scrolls it within its commands, the pane staying put", async ($, on) => {
	const { bash, wheel, moves, offset, draw } = setup($, on);
	for (let i = 0; i < MORE; i++) {
		await bash(`echo ${i}`);
	}
	await draw();
	const top = LIST_TOP;

	expect(await wheel(top, 1)).toEqual({});
	expect(offset()).toBe(1);
	await wheel(top + 2, 3);
	expect(offset()).toBe(MORE - HISTORY_ROWS);
	await wheel(top + HISTORY_ROWS - 1, -10);
	expect(offset()).toBe(0);
	expect(moves).toEqual([]);

	// the title row, the row past the list, the scroll keys: the pane moves
	await wheel(top - 1, 1);
	await wheel(top + HISTORY_ROWS, 1);
	await wheel(undefined, 1);
	expect(moves).toHaveLength(3);
	expect(offset()).toBe(0);
});

test("a list with nothing to scroll leaves the wheel to the pane and draws no ▲/▼", async ($, on) => {
	const { bash, wheel, moves, offset, pane } = setup($, on);
	for (let i = 0; i < HISTORY_ROWS; i++) {
		await bash(`echo ${i}`);
	}
	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await pane(surface);
		const { rows } = await drawnPane(ui);
		expect(rows).toHaveLength(HISTORY_ROWS);
		expect(await ui.find({ key: "history-up" })).toBeUndefined();
		expect(await ui.find({ key: "history-down" })).toBeUndefined();
		expect(
			await ui.find({ text: new RegExp(`^commands {2}${HISTORY_ROWS}$`) }),
		).toBeDefined();
		await ui.unmount();
	}

	await wheel(LIST_TOP, 1);
	expect(moves).toHaveLength(1);
	expect(offset()).toBe(0);
});

test("a new command: the list at its top follows it, one scrolled down keeps its rows", async ($, on) => {
	const { bash, wheel, commands, offset, draw } = setup($, on);
	const inView = () =>
		commands()
			.slice(offset(), offset() + HISTORY_ROWS)
			.map((c) => c.command);
	// the box's rows from `echo <from>` down
	const echoes = (from: number) =>
		Array.from({ length: HISTORY_ROWS }, (_, i) => `echo ${from - i}`);
	for (let i = 0; i < MORE; i++) {
		await bash(`echo ${i}`);
	}
	expect(offset()).toBe(0);
	expect(inView()[0]).toBe(`echo ${MORE - 1}`);

	await draw();
	await wheel(LIST_TOP, 2);
	const seen = inView();
	expect(seen).toEqual(echoes(HISTORY_ROWS - 1));
	await bash("ls", "a1");
	expect(offset()).toBe(3);
	expect(inView()).toEqual(seen);

	// ten kept: the rows stay until the oldest falls off, then the clamp moves them
	for (let i = 0; commands().length < HISTORY_MAX; i++) {
		await bash(`date ${i}`);
	}
	expect(offset()).toBe(HISTORY_MAX - HISTORY_ROWS);
	expect(inView()).toEqual(seen);
	await bash("pwd");
	expect(offset()).toBe(HISTORY_MAX - HISTORY_ROWS);
	expect(inView()).toEqual(echoes(HISTORY_ROWS));
});

test("the list sits below the alerts box while it shows", async ($, on) => {
	const { bash, wheel, moves, offset, draw } = setup($, on);
	// a failed call raises an alert
	await bash("false");
	for (let i = 0; i < HISTORY_ROWS; i++) {
		await bash(`echo ${i}`);
	}
	await draw();

	await wheel(LIST_TOP, 1);
	expect(moves).toHaveLength(1);
	// the alerts box: two borders, its title and the alert
	await wheel(LIST_TOP + 4, 1);
	expect(moves).toHaveLength(1);
	expect(offset()).toBe(1);
});

test("a pointer row counts from the pane window's first row", async ($, on) => {
	const { bash, wheel, moves, offset, draw } = setup($, on);
	for (let i = 0; i < MORE; i++) {
		await bash(`echo ${i}`);
	}
	await draw();
	const view = { offset: 2, contentRows: 60, bodyRows: 40 };

	// inside the window's range the move tells where it stands
	await wheel(LIST_TOP - 2, 1, view);
	expect(offset()).toBe(1);

	// at an edge it is the offset the pane was last drawn with
	const ui = await $.ui.mount({
		plugin: "summary",
		surface: "terminal",
		...PANE,
		props: { ...PANE.props, scroll: { offset: 20, bodyRows: 40 } },
	});
	await ui.unmount();
	await wheel(LIST_TOP - 20, 1, { ...view, offset: 20 });
	expect(offset()).toBe(2);
	expect(moves).toEqual([]);
});

test("clampHistory keeps the list's first row in range", () => {
	expect(clampHistory(-1, 10)).toBe(0);
	expect(clampHistory(9, 10)).toBe(10 - HISTORY_ROWS);
	expect(clampHistory(1, 2)).toBe(0);
});

test("the box shows five commands, its place in the list and ▲/▼", async ($, on) => {
	const done = (id: string, command: string): CommandRun => ({
		id,
		command,
		startedAt: 0,
		endedAt: 1_000,
		result: "ok",
	});
	const runs: CommandRun[] = [
		{ id: "c0", command: "sleep 9", startedAt: 0 },
		{
			id: "c1",
			command: "false",
			startedAt: 0,
			endedAt: 2_000,
			result: "failed",
		},
		{
			id: "c2",
			command: "rm -rf /",
			startedAt: 0,
			endedAt: 0,
			result: "denied",
		},
		done("c3", "ls"),
		done("c4", "pwd"),
		done("c5", "date"),
		done("c6", "whoami"),
	];
	const view = { commands: runs, offset: 1 };
	const scrolled: number[] = [];
	on("ui.render", { component: "Pane", requestId: "history" }, ($, e) =>
		historyBox({
			els: $.ui.resolve(e),
			t: 3_000,
			width: 60,
			...view,
			onScroll: (by) => scrolled.push(by),
		}),
	);
	// summary does not draw this id, so the test's hook does
	const mount = (surface: "terminal" | "desktop") =>
		$.ui.mount({ plugin: "summary", ...PANE, requestId: "history", surface });

	expect(HISTORY_ROWS).toBe(5);
	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await mount(surface);
		expect(await ui.find({ text: /^commands {2}2-6\/7$/ })).toBeDefined();
		const rows = await ui.findAll({ type: "Text", text: /^[✓✗■⠋-⠿] / });
		expect(rows.map((r) => r.text)).toEqual([
			"✗ false  2s",
			"■ rm -rf /  0s",
			"✓ ls  1s",
			"✓ pwd  1s",
			"✓ date  1s",
		]);
		await ui.press({ key: "history-down", plugin: "test" });
		await ui.press({ key: "history-up", plugin: "test" });
		await ui.unmount();
	}
	expect(scrolled).toEqual([1, -1, 1, -1]);

	// as many as it shows: nothing to scroll, no ▲/▼
	view.commands = runs.slice(0, HISTORY_ROWS);
	view.offset = 0;
	const full = await mount("terminal");
	expect(await full.find({ text: /^commands {2}5$/ })).toBeDefined();
	expect(await full.findAll({ type: "Button" })).toHaveLength(0);
	await full.unmount();

	view.commands = runs.slice(0, 2);
	const ui = await mount("terminal");
	expect(await ui.find({ text: /^commands {2}2$/ })).toBeDefined();
	expect(await ui.findAll({ type: "Button" })).toHaveLength(0);
	expect(await ui.find({ text: /^⠋ sleep 9 {2}3s$/ })).toBeDefined();
	await ui.unmount();

	view.commands = [];
	const empty = await mount("terminal");
	expect(await empty.find({ text: "no command yet" })).toBeDefined();
	await empty.unmount();
});

test("the pane lists the commands Claude ran, ▼/▲ moving the five it shows", async ($, on) => {
	const { bash, pane } = setup($, on);
	for (let i = 0; i < MORE; i++) {
		await bash(`echo ${i}`);
	}
	// the box's rows from `echo <from>` down
	const echoes = (from: number) =>
		Array.from({ length: HISTORY_ROWS }, (_, i) => `✓ echo ${from - i}  0s`);
	const place = (at: number) =>
		new RegExp(`^commands {2}${at + 1}-${at + HISTORY_ROWS}/${MORE}$`);

	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await pane(surface);
		expect(await ui.find({ text: place(0) })).toBeDefined();
		expect((await drawnPane(ui)).rows).toEqual(echoes(MORE - 1));
		await ui.press({ key: "history-down" });
		expect(await ui.find({ text: place(1) })).toBeDefined();
		expect((await drawnPane(ui)).rows).toEqual(echoes(MORE - 2));
		await ui.press({ key: "history-up" });
		expect((await drawnPane(ui)).rows[0]).toBe(`✓ echo ${MORE - 1}  0s`);
		await ui.unmount();
	}
});

test("the commands box stands right under recent, the alerts above both", async ($, on) => {
	const { bash, pane } = setup($, on);
	await bash("ls");
	const order = async (surface: "terminal" | "desktop", alerts: boolean) => {
		const ui = await pane(surface);
		const { labels } = await drawnPane(ui);
		await ui.unmount();
		expect(labels.slice(0, alerts ? 5 : 4)).toEqual([
			"header",
			"rule",
			...(alerts ? ["alerts"] : []),
			"recent",
			"commands",
		]);
	};
	for (const surface of ["terminal", "desktop"] as const) {
		await order(surface, false);
	}
	// each failed call raises an alert
	await bash("false");
	for (const surface of ["terminal", "desktop"] as const) {
		await order(surface, true);
	}
});

test("the commands box draws to the pane's width", async ($, on) => {
	const { bash, pane } = setup($, on);
	const long = `echo ${"x".repeat(95)}`;
	await bash(long);

	for (const surface of ["terminal", "desktop"] as const) {
		// 140 cells hold the whole command inside the box's frame
		const wide = await pane(surface, 140);
		expect((await drawnPane(wide)).rows).toEqual([`✓ ${long}  0s`]);
		await wide.unmount();

		const narrow = await pane(surface, 60);
		const [row = ""] = (await drawnPane(narrow)).rows;
		await narrow.unmount();
		expect(row).toMatch(/^✓ echo x+… {2}0s$/);
		expect(cells(row)).toBe(60 - 4);
	}
});

test("a command left in the background shows as a shell, then as ended once it leaves the tasks", async ($, on) => {
	const { bash, commands, pane } = setup($, on);
	const background = { run_in_background: true };
	await bash("npm run dev", undefined, background);
	await bash("bun test --watch", undefined, background);
	expect(commands()).toMatchObject([
		{ result: "bg", shell: "bg-bun test --watch" },
		{ result: "bg", shell: "bg-npm run dev" },
	]);
	// the mark and how dim the command is, row by row
	const marks = async (surface: "terminal" | "desktop") => {
		const ui = await pane(surface);
		const { box } = await drawnPane(ui);
		await ui.unmount();
		return (box?.children ?? []).slice(1).map((row) => {
			const [mark, , command] = (row as Drawn).children as Drawn[];
			return [
				textOf(row as Drawn),
				mark?.props?.color,
				command?.props?.dimColor === true,
			];
		});
	};

	for (const surface of ["terminal", "desktop"] as const) {
		expect(await marks(surface)).toEqual([
			["● bun test --watch  bg", C.yellow, false],
			["● npm run dev  bg", C.yellow, false],
		]);
	}

	// stopped by TaskStop, or gone from the tasks a stop reports
	await $.tool.call({ tool: "TaskStop", task_id: "bg-npm run dev" });
	await $.classic.Stop({
		stop_hook_active: false,
		background_tasks: [
			{
				id: "bg-bun test --watch",
				type: "shell",
				status: "running",
				description: "watch",
				command: "bun test --watch",
			},
		],
	});
	for (const surface of ["terminal", "desktop"] as const) {
		expect(await marks(surface)).toEqual([
			["● bun test --watch  bg", C.yellow, false],
			["○ npm run dev  bg", C.overlay, true],
		]);
	}
	await $.classic.Stop({ stop_hook_active: false, background_tasks: [] });
	for (const surface of ["terminal", "desktop"] as const) {
		expect((await marks(surface))[0]).toEqual([
			"○ bun test --watch  bg",
			C.overlay,
			true,
		]);
	}
});

test("a wide command is cut by terminal cells, keeping the subagent and the time", async ($, on) => {
	const { bash, spawn, pane } = setup($, on);
	await spawn("general-purpose", "리뷰어");
	await bash(`echo ${"한글".repeat(40)}`, "a1");

	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await pane(surface, 60);
		const [row = ""] = (await drawnPane(ui)).rows;
		await ui.unmount();
		expect(row).toMatch(/^✓ echo (한글)+한?… @리뷰어 {2}0s$/);
		// inside the box's frame and padding
		expect(cells(row)).toBeLessThanOrEqual(60 - 4);
		expect(cells(row)).toBeGreaterThanOrEqual(60 - 4 - 1);
	}
});

test("fit cuts by cells, a wide character taking two", () => {
	expect(fit("ls -la", 10)).toBe("ls -la");
	expect(fit("한글한글", 8)).toBe("한글한글");
	expect(fit("한글한글", 7)).toBe("한글한…");
	expect(fit("a한글", 4)).toBe("a한…");
	expect(cells(fit("한".repeat(30), 21))).toBe(21);
});
