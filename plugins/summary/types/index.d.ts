export type AgentRow = {
	id: string;
	label: string;
	name?: string;
	model: string;
	description: string;
	startedAt: number;
	endedAt?: number;
	status: "running" | "idle" | "done" | "failed" | "killed";
	tool?: string;
	listed?: boolean;
};

export type WorkItem = {
	id: string;
	at: number;
	durationMs: number;
	tokens?: number;
	text?: string;
	ask?: string;
	answer?: string;
};

export type Alert = {
	at: number;
	tool: string;
	reason: string;
	agent?: string;
};

export type SkillRun = {
	skills: string[];
	model: string;
	effort?: string;
	startedAt: number;
	endedAt?: number;
	result?: "done" | "failed" | "aborted";
};

export type BackgroundTask = {
	id: string;
	type: string;
	status: string;
	label: string;
};

export type SessionCron = {
	id: string;
	schedule: string;
	recurring: boolean;
	prompt: string;
};

export type Commit = {
	hash: string;
	at: number;
	subject: string;
};

export type RepoState = {
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	commits: Commit[];
};

export type PullRequest = {
	branch: string;
	number: number;
	url: string;
	isDraft: boolean;
	review: "approved" | "changes" | "pending";
	ci?: "success" | "failure" | "pending";
	unresolved: number;
};

export type TurnMark = {
	ms: number;
	ok: boolean;
};

// a Bash command Claude ran; result is absent while it runs
export type CommandRun = {
	id: string;
	command: string;
	// the subagent that ran it, by its row's label; absent for the main agent
	agent?: string;
	startedAt: number;
	endedAt?: number;
	// bg: it left a shell running in the background
	result?: "ok" | "failed" | "denied" | "bg";
	// that shell's task id, while the tasks list still runs it
	shell?: string;
};

declare module "claude-code" {
	interface PluginState {
		summary: {
			agents: AgentRow[];
			now: number;
			recent: WorkItem[];
			dirty: number;
			alerts: Alert[];
			runs: SkillRun[];
			model: string;
			shown: boolean;
			chord: string;
			tabs: string;
			working: number;
			tasks: BackgroundTask[];
			crons: SessionCron[];
			turns: TurnMark[];
			repo: RepoState;
			pr: PullRequest | null;
			autoOpened: boolean;
			commands: CommandRun[];
			historyAt: number;
		};
	}
}
