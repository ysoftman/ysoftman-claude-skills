import type { Elements, RenderInput } from "claude-code";
import type { CommandRun } from "../types";
import { cells, elapsed } from "./format";
import { C, SPINNER } from "./theme";

// commands kept, and the rows the box shows of them
export const HISTORY_MAX = 10;
export const HISTORY_ROWS = 5;

const MARK: Record<
	NonNullable<CommandRun["result"]>,
	{ icon: string; color: string }
> = {
	ok: { icon: "✓", color: C.green },
	failed: { icon: "✗", color: C.red },
	denied: { icon: "■", color: C.overlay },
	// a background shell: ● while it runs, ○ (BG_OVER) once it ends
	bg: { icon: "●", color: C.yellow },
};

// a background shell that ended
const BG_OVER = { icon: "○", color: C.overlay };

// s cut to `room` terminal cells, a wide character taking two
export const fit = (s: string, room: number) => {
	if (cells(s) <= room) {
		return s;
	}
	let out = "";
	// the ellipsis
	let used = 1;
	for (const ch of s) {
		used += cells(ch);
		if (used > room) {
			break;
		}
		out += ch;
	}
	return `${out}…`;
};

// the list's first shown command, 0..count - HISTORY_ROWS
export const clampHistory = (offset: number, count: number) =>
	Math.max(0, Math.min(offset, count - HISTORY_ROWS));

export type HistoryValues = {
	els: Elements[RenderInput<"Pane">["surface"]];
	t: number;
	width: number;
	commands: CommandRun[];
	offset: number;
	onScroll: (by: number) => unknown;
};

// newest first, always min(count, HISTORY_ROWS) list rows so the rows under
// it stay put; ▲/▼ for a surface whose wheel does not reach the pane
export const historyBox = ({
	els,
	t,
	width,
	commands,
	offset,
	onScroll,
}: HistoryValues) => {
	const { Box, Button, Text } = els;
	const at = clampHistory(offset, commands.length);
	const shown = commands.slice(at, at + HISTORY_ROWS);
	const spin = SPINNER[Math.floor(t / 100) % SPINNER.length];
	const canScroll = commands.length > HISTORY_ROWS;

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={C.surface1}
			paddingX={1}
		>
			<Box justifyContent="space-between">
				<Text>
					<Text bold color={C.teal}>
						commands
					</Text>
					{commands.length > 0 && (
						<Text color={C.overlay}>
							{canScroll
								? `  ${at + 1}-${at + shown.length}/${commands.length}`
								: `  ${commands.length}`}
						</Text>
					)}
				</Text>
				{canScroll && (
					<Box gap={1}>
						<Button
							plain
							key="history-up"
							dimColor={at === 0}
							onPress={() => onScroll(-1)}
						>
							▲
						</Button>
						<Button
							plain
							key="history-down"
							dimColor={at === commands.length - HISTORY_ROWS}
							onPress={() => onScroll(1)}
						>
							▼
						</Button>
					</Box>
				)}
			</Box>
			{commands.length === 0 && <Text color={C.overlay}>no command yet</Text>}
			{shown.map((c) => {
				const mark =
					c.result === undefined
						? undefined
						: c.result === "bg" && c.shell === undefined
							? BG_OVER
							: MARK[c.result];
				const took =
					c.result === "bg" ? "bg" : elapsed((c.endedAt ?? t) - c.startedAt);
				const by = c.agent === undefined ? "" : ` @${c.agent}`;
				// border, padding, the mark and the gap before the time
				const room = Math.max(1, width - 4 - 2 - 2 - cells(took) - cells(by));
				return (
					<Text wrap="truncate-end">
						{mark === undefined ? (
							<Text color={C.peach}>{spin}</Text>
						) : (
							<Text color={mark.color}>{mark.icon}</Text>
						)}{" "}
						<Text
							color={c.result === undefined ? C.text : C.subtext}
							dimColor={c.result === "denied" || mark === BG_OVER}
						>
							{fit(c.command, room)}
						</Text>
						{by !== "" && (
							<Text color={C.overlay} dimColor>
								{by}
							</Text>
						)}
						<Text color={C.overlay} dimColor>{`  ${took}`}</Text>
					</Text>
				);
			})}
		</Box>
	);
};
