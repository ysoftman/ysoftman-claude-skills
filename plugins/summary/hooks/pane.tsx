import type { Elements, RenderInput } from "claude-code";
import type {
	AgentRow,
	Alert,
	CommandRun,
	PullRequest,
	RepoState,
	SessionCron,
	SkillRun,
	TurnMark,
	WorkItem,
} from "../types";
import { hhmm, nextFire } from "./cron";
import { ago, elapsed, kilo, wrap } from "./format";
import { historyBox } from "./history";
import { isMergeable } from "./pr";
import type { Rain } from "./rain";
import { RAIN, RAIN_ROWS, rainCells, rainMessage } from "./rain";
import { isBusy, isOpenRun } from "./status";
import {
	C,
	CHECKS,
	GLOW,
	modelColor,
	PANE,
	REVIEW,
	RUN,
	SHOWN,
	SPARK,
	SPINNER,
} from "./theme";

// Everything the pane draws, read by register (only it may touch $).
export type PaneValues = {
	e: RenderInput<"Pane">;
	els: Elements[RenderInput<"Pane">["surface"]];
	t: number;
	root: string | undefined;
	rain: Rain;
	hint: string;
	tabKeys: string;
	onToggle: () => unknown;
	list: AgentRow[];
	runs: SkillRun[];
	work: WorkItem[];
	uncommitted: number;
	git: RepoState;
	pr: PullRequest | null;
	warnings: Alert[];
	tag: string;
	since: number;
	scheduled: SessionCron[];
	marks: TurnMark[];
	commands: CommandRun[];
	historyAt: number;
	onHistoryScroll: (by: number) => unknown;
	// the commands list's first row in the tree as drawn, for the wheel
	onHistoryTop: (row: number) => unknown;
};

export const paneView = ({
	e,
	els,
	t,
	root,
	rain,
	hint,
	tabKeys,
	onToggle,
	list,
	runs,
	work,
	uncommitted,
	git,
	pr,
	warnings,
	tag,
	since,
	scheduled,
	marks,
	commands,
	historyAt,
	onHistoryScroll,
	onHistoryTop,
}: PaneValues) => {
	const { Box, Button, Link, Text } = els;
	const frame = Math.floor(t / 100);
	const spin = SPINNER[frame % SPINNER.length];
	const busy = isBusy(list, runs, work);
	const glow = busy ? (GLOW[frame % GLOW.length] ?? C.mauve) : C.mauve;
	const width = Math.max(30, e.props.bodyColumns);
	// cells inside a box's frame and padding
	const inner = width - 4;
	const rule = width - 2;
	const at = busy ? (frame % (rule + 6)) - 3 : -3;
	const lit = [at, at + 3].map((n) => Math.min(rule, Math.max(0, n))) as [
		number,
		number,
	];
	const spark = marks.slice(-inner);
	const longest = Math.max(1, ...spark.map((m) => m.ms));
	// the crons the last stop reported, the first SHOWN of them drawn
	const cronsShown = scheduled.slice(0, SHOWN);
	const more = scheduled.length - cronsShown.length;
	const turnStats =
		marks.length === 0
			? ""
			: `  ${marks.length} turn${marks.length === 1 ? "" : "s"} · avg ${elapsed(
					marks.reduce((n, m) => n + m.ms, 0) / marks.length,
				)} · max ${elapsed(Math.max(...marks.map((m) => m.ms)))}`;
	if ("Raster" in els) {
		rain.columns = width;
	}
	// docked, the pane fills its height so the rain sits on the bottom edge;
	// inline, the frame fits the tree and would grow to bodyRows instead
	const floor =
		e.props.placement === "dock" ? e.props.scroll.bodyRows : undefined;
	const skill = runs.at(-1);
	const agentsRunning = list.filter((a) => a.status === "running").length;
	// what keeps Claude busy, one mark each, in the colors of their boxes
	const status = [
		...(since > 0
			? [{ color: C.peach, text: `⏳ working ${elapsed(t - since)}` }]
			: []),
		...(isOpenRun(skill) && skill !== undefined
			? [
					{
						color: C.blue,
						text: `🔧 ${skill.skills.join(", ")} ${elapsed(t - skill.startedAt)}`,
					},
				]
			: []),
		...(agentsRunning > 0
			? [
					{
						color: C.mauve,
						text: `🤖 ${agentsRunning} agent${agentsRunning === 1 ? "" : "s"}`,
					},
				]
			: []),
		...(work.some((w) => w.text === undefined)
			? [{ color: C.green, text: "📝 summarizing" }]
			: []),
	];
	// a PR read for the branch before a checkout is not this one's
	const pull = pr !== null && pr.branch === git.branch ? pr : undefined;
	const gitLine =
		root === undefined
			? "  not a repository"
			: `  ${git.branch ?? "?"}${
					git.upstream === undefined
						? ` (no upstream) · ${uncommitted} uncommitted`
						: ` → ${git.upstream} · ${uncommitted} uncommitted · ↑${git.ahead} ↓${git.behind}`
				}`;
	const prMarks =
		pull === undefined
			? []
			: [
					...(pull.isDraft ? [{ color: C.overlay, text: "✎ draft" }] : []),
					REVIEW[pull.review],
					...(pull.ci === undefined ? [] : [CHECKS[pull.ci]]),
					...(pull.unresolved > 0
						? [{ color: C.peach, text: `💬 ${pull.unresolved} unresolved` }]
						: []),
				];
	const keycap = (k: string) => (
		<Text backgroundColor={C.surface0} color={C.lavender}>{` ${k} `}</Text>
	);
	// recent's summaries in lines that fit beside the mark, a row each, so the
	// rows above the commands list are known
	const workLines = work.map((w) => wrap(w.text ?? "summarizing…", inner - 2));
	// The commands list's first row in the tree, for the wheel: the header and
	// the rule a row each, the alerts box (two borders, a title, a row each),
	// scheduled (two borders, a title, a row a cron, one for +N more) and recent
	// (two borders, a title, a row a summary line, one for each item's time),
	// then the list's own top border and title.
	onHistoryTop(
		2 +
			(warnings.length > 0 ? warnings.length + 3 : 0) +
			(scheduled.length > 0 ? 3 + cronsShown.length + (more > 0 ? 1 : 0) : 0) +
			3 +
			(work.length === 0
				? 1
				: workLines.reduce((n, lines) => n + lines.length + 1, 0)) +
			2,
	);

	return (
		<Box
			flexDirection="column"
			width={width}
			{...(floor === undefined ? {} : { minHeight: floor })}
		>
			<Box paddingX={1} justifyContent="space-between">
				<Box gap={2}>
					<Text bold color={glow}>
						SUMMARY
					</Text>
					{status.length > 0 && (
						<Text wrap="truncate-end">
							{status.map((m, i) => (
								<Text color={m.color}>{`${i > 0 ? "  " : ""}${m.text}`}</Text>
							))}
						</Text>
					)}
				</Box>
				<Text color={modelColor(tag)}>{tag}</Text>
			</Box>
			<Box paddingX={1}>
				<Text>
					<Text color={C.surface0}>{"━".repeat(lit[0])}</Text>
					<Text color={C.lavender}>{"━".repeat(lit[1] - lit[0])}</Text>
					<Text color={C.surface0}>{"━".repeat(rule - lit[1])}</Text>
				</Text>
			</Box>
			{warnings.length > 0 && (
				<Box
					flexDirection="column"
					borderStyle="round"
					borderColor={C.red}
					paddingX={1}
				>
					<Text bold color={C.red}>
						alerts
					</Text>
					{warnings.map((a) => (
						<Text wrap="truncate-end">
							<Text color={C.red}>✗</Text>{" "}
							<Text color={C.overlay}>{`${ago(t - a.at)} ago`.padEnd(7)}</Text>{" "}
							<Text color={C.peach}>{a.tool}</Text>
							{a.agent !== undefined && (
								<Text color={C.overlay}>{` @${a.agent}`}</Text>
							)}
							<Text color={C.subtext}>{`  ${a.reason}`}</Text>
						</Text>
					))}
				</Box>
			)}
			{/* crons, only while there are some: what runs next leads */}
			{scheduled.length > 0 && (
				<Box
					flexDirection="column"
					borderStyle="round"
					borderColor={C.surface1}
					paddingX={1}
				>
					<Text>
						<Text bold color={C.lavender}>
							scheduled
						</Text>
						<Text color={C.overlay}>{`  ${scheduled.length}`}</Text>
					</Text>
					{cronsShown.map((c) => {
						const at = nextFire(c.schedule, t);
						return (
							<Text wrap="truncate-end">
								<Text color={C.lavender}>{c.recurring ? "↻" : "◷"}</Text>{" "}
								<Text color={C.text}>
									{at === undefined
										? c.schedule
										: `${hhmm(at, t)} in ${ago(at - t)}`}
								</Text>{" "}
								<Text color={C.subtext}>{c.prompt}</Text>
							</Text>
						);
					})}
					{more > 0 && <Text color={C.overlay}>{`+${more} more`}</Text>}
				</Box>
			)}
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={C.green}
				paddingX={1}
			>
				<Text bold color={C.green}>
					recent
				</Text>
				{work.length === 0 && (
					<Text color={C.overlay}>no finished work yet</Text>
				)}
				{work.map((w, i) => {
					const line = (text: string) => (
						<Text
							wrap="truncate-end"
							bold={i === 0}
							dimColor={i > 0}
							color={w.text === undefined ? C.subtext : C.text}
						>
							{text}
						</Text>
					);
					return (
						<Box flexDirection="column">
							{(workLines[i] ?? []).map((text, j) =>
								j === 0 ? (
									<Box gap={1}>
										{w.text === undefined ? (
											<Text color={C.peach}>{spin}</Text>
										) : (
											<Text color={C.green}>✓</Text>
										)}
										{line(text)}
									</Box>
								) : (
									<Box paddingLeft={2}>{line(text)}</Box>
								),
							)}
							<Box paddingLeft={2}>
								<Text wrap="truncate-end" color={C.overlay} dimColor>
									{[
										`${ago(t - w.at)} ago`,
										elapsed(w.durationMs),
										...(w.tokens === undefined ? [] : [kilo(w.tokens)]),
									].join(" · ")}
								</Text>
							</Box>
						</Box>
					);
				})}
			</Box>
			{historyBox({
				els,
				t,
				width,
				commands,
				offset: historyAt,
				onScroll: onHistoryScroll,
			})}
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={C.surface1}
				paddingX={1}
			>
				<Text>
					<Text bold color={C.peach}>
						git
					</Text>
					<Text color={C.overlay}>{gitLine}</Text>
				</Text>
				{pull !== undefined && (
					<Text wrap="truncate-end">
						<Text color={C.lavender}>{`PR #${pull.number}`}</Text>
						{prMarks.map((m, i) => (
							<Text color={m.color}>{`${i === 0 ? " " : " · "}${m.text}`}</Text>
						))}
					</Text>
				)}
				{pull !== undefined && isMergeable(pull) && (
					<Box flexDirection="column" paddingLeft={2}>
						<Text color={C.green} wrap="truncate-end">
							⇢ ready: merge it in the web UI
						</Text>
						<Text color={C.blue}>
							<Link href={pull.url} />
						</Text>
					</Box>
				)}
				{git.commits.length === 0 && (
					<Text color={C.overlay}>no commit yet</Text>
				)}
				{git.commits.map((c, i) => (
					<Text wrap="truncate-end">
						{git.upstream === undefined ? (
							<Text color={C.overlay}>·</Text>
						) : i < git.ahead ? (
							<Text color={C.yellow}>↑</Text>
						) : (
							<Text color={C.green}>✓</Text>
						)}{" "}
						<Text color={C.overlay}>{c.hash}</Text>{" "}
						<Text color={C.overlay} dimColor>
							{ago(t - c.at).padStart(3)}
						</Text>{" "}
						<Text color={i < git.ahead ? C.text : C.subtext}>{c.subject}</Text>
					</Text>
				))}
			</Box>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={C.surface1}
				paddingX={1}
			>
				<Text bold color={C.blue}>
					skills
				</Text>
				{runs.length === 0 ? (
					<Text color={C.overlay}>no skill yet</Text>
				) : (
					[...runs].reverse().map((r) => (
						<Text wrap="truncate-end">
							{r.result === undefined ? (
								<Text color={C.peach}>{spin}</Text>
							) : (
								<Text color={RUN[r.result].color}>{RUN[r.result].icon}</Text>
							)}{" "}
							<Text
								bold={r.result === undefined}
								color={r.result === undefined ? C.text : C.subtext}
							>
								{r.skills.join(", ")}
							</Text>{" "}
							<Text color={modelColor(r.model)}>
								{[r.model, r.effort].filter((v) => v !== undefined).join(" · ")}
							</Text>{" "}
							<Text color={C.overlay}>
								{elapsed((r.endedAt ?? t) - r.startedAt)}
							</Text>
						</Text>
					))
				)}
			</Box>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={C.surface1}
				paddingX={1}
			>
				<Text>
					<Text bold color={C.sky}>
						turn time
					</Text>
					{marks.length > 0 && <Text color={C.overlay}>{turnStats}</Text>}
				</Text>
				{spark.length === 0 ? (
					<Text color={C.overlay}>no turn yet</Text>
				) : (
					<Text>
						{spark.map((m) => (
							<Text color={m.ok ? C.green : C.red}>
								{SPARK[Math.max(0, Math.ceil((m.ms / longest) * 8) - 1)]}
							</Text>
						))}
					</Text>
				)}
			</Box>
			<Box paddingX={1} columnGap={2} flexWrap="wrap">
				<Button plain key="toggle" onPress={onToggle}>
					{keycap(hint)}
					<Text color={C.subtext}> close</Text>
				</Button>
				<Text>
					{keycap("ctrl+x tab")}
					<Text color={C.subtext}> focus</Text>
				</Text>
				{tabKeys !== "" && (
					<Text>
						{keycap(tabKeys)}
						<Text color={C.subtext}> tabs</Text>
					</Text>
				)}
				{keycap(`/${PANE} help`)}
			</Box>
			{/* hint falls back to the slash command while no key is bound */}
			{(hint === `/${PANE}` || tabKeys === "") && (
				<Box flexDirection="column" paddingX={1}>
					<Text color={C.yellow}>
						{
							'⚠ shortcuts not set · you can ask Claude "set up shortcuts per the summary mod README"'
						}
					</Text>
					<Text color={C.subtext}>
						or add to ~/.claude/keybindings.json (merge into existing blocks):
					</Text>
					{hint === `/${PANE}` && (
						<Text color={C.subtext}>
							{`  "Chat": "ctrl+x s": "command:${PANE}"`}
						</Text>
					)}
					{tabKeys === "" && (
						<Text color={C.subtext}>
							{'  "Global": "ctrl+<": "pane:previous", "ctrl+>": "pane:next"'}
						</Text>
					)}
					{tabKeys === "" && (
						<Text color={C.subtext}>
							{
								'  also "ctrl+shift+," / "ctrl+shift+." if your terminal sends those'
							}
						</Text>
					)}
				</Box>
			)}
			<Box flexGrow={1} />
			{"Raster" in els && (
				<els.Raster
					key={RAIN}
					columns={width}
					rows={RAIN_ROWS}
					cells={rainCells(
						rain.t,
						width,
						RAIN_ROWS,
						rain.pace === 0 ? rainMessage(width, rain.idleSince, t) : undefined,
					)}
				/>
			)}
		</Box>
	);
};
