import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Defaults target Daniel's WSL setup; override with env vars.
const VAULT = process.env.PI_OBSIDIAN_VAULT ?? "obsidian-db";
const VAULT_PATH = process.env.PI_OBSIDIAN_VAULT_PATH ?? "/mnt/d/obsidian-db";
const FOLDER = process.env.PI_OBSIDIAN_FOLDER ?? "pi-sessions";
const ENTRY = "render-in-obsidian";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d: Date) => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function noteName(date: Date, sessionId: string, title: string): string {
	const clean = title.replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
	return `${day(date)}-${pad(date.getHours())}${pad(date.getMinutes())} - ${sessionId.slice(0, 8)} - ${clean || "untitled"}.md`;
}

/** Markdown text of an assistant message, without thinking or tool calls. */
export function assistantText(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block: any) => block.type === "text")
		.map((block: any) => block.text)
		.join("\n\n")
		.trim();
}

const userText = (message: any): string =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");

export const section = (text: string, at: Date) => `# ${stamp(at)}\n\n${text}\n\n---\n\n`;

/**
 * JS for `obsidian eval`: once Obsidian has loaded the appended text, run Gremlins'
 * "Fix all in current note" in the open note and save it. Reading mode has no live
 * editor, so it switches to source mode for a moment and back. It does nothing when the
 * plugin is off or the note isn't open.
 */
export const gremlinsScript = (path: string) => `(async () => {
	const path = ${JSON.stringify(path)};
	const cmd = app.commands.commands["gremlins:fix-current-note"];
	if (!app.plugins.enabledPlugins.has("gremlins") || !cmd?.editorCallback) return "no-plugin";
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const disk = await app.vault.adapter.read(path);
	for (let i = 0; i < 50; i++) {
		const view = app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v) => v.file?.path === path);
		if (!view) return "not-open";
		if (view.data !== disk) { await sleep(100); continue; }
		const mode = view.getMode();
		if (mode !== "source") { await view.setState({ ...view.getState(), mode: "source" }, { history: false }); await sleep(50); }
		if (view.editor.getValue() !== disk) view.editor.setValue(disk);
		cmd.editorCallback(view.editor, view);
		await view.save();
		if (mode !== "source") await view.setState({ ...view.getState(), mode }, { history: false });
		return "fixed";
	}
	return "stale";
})()`;

export default function (pi: ExtensionAPI) {
	let notePath: string | undefined; // vault-relative

	const setStatus = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(ENTRY, notePath ? ctx.ui.theme.fg("accent", "◆ obsidian") : undefined);

	const obsidian = (...args: string[]) =>
		new Promise<string>((resolve, reject) =>
			execFile("obsidian", [`vault=${VAULT}`, ...args], { timeout: 30_000 }, (error, stdout) => {
				const out = String(stdout).trim();
				if (error || /^error/i.test(out)) reject(new Error(error?.message ?? out));
				else resolve(out);
			}),
		);

	const open = async (ctx: ExtensionContext) => {
		if (!notePath) return;
		try {
			await obsidian("open", `path=${notePath}`);
		} catch (error) {
			ctx.ui.notify(`Could not open in Obsidian: ${(error as Error).message}`, "warning");
		}
	};

	// Runs Gremlins "Fix all in current note" on the note if the plugin is enabled and the note is open.
	// Serialized so overlapping answers don't race each other.
	let fixing: Promise<unknown> = Promise.resolve();
	const fixGremlins = (ctx: ExtensionContext) => {
		const path = notePath;
		if (!path) return;
		fixing = fixing.then(async () => {
			try {
				const out = await obsidian("eval", `code=${gremlinsScript(path)}`);
				if (out.includes("stale")) ctx.ui.notify("Gremlins: note did not reload in time, skipped fix", "warning");
			} catch (error) {
				ctx.ui.notify(`Gremlins fix failed: ${(error as Error).message}`, "warning");
			}
		});
	};

	const append = async (text: string, at: Date) => {
		if (notePath && text) await appendFile(join(VAULT_PATH, notePath), section(text, at));
	};

	pi.on("session_start", async (_event, ctx) => {
		notePath = undefined;
		for (const entry of ctx.sessionManager.getEntries() as any[]) {
			if (entry.type === "custom" && entry.customType === ENTRY) notePath = entry.data?.notePath;
		}
		setStatus(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!notePath) return;
		const last = [...event.messages].reverse().map(assistantText).find(Boolean);
		try {
			if (!last) return;
			await append(last, new Date());
			fixGremlins(ctx);
		} catch (error) {
			ctx.ui.notify(`render-in-obsidian: ${(error as Error).message}`, "error");
		}
	});

	pi.registerCommand("render-in-obsidian", {
		description: `Mirror final agent outputs into ${VAULT}/${FOLDER} (args: off)`,
		handler: async (args, ctx) => {
			if (args.trim() === "off") {
				notePath = undefined;
				pi.appendEntry(ENTRY, { notePath: null });
				setStatus(ctx);
				ctx.ui.notify("Disconnected from Obsidian", "info");
				return;
			}
			if (notePath) {
				await open(ctx);
				return;
			}

			const sm = ctx.sessionManager;
			const branch = sm.getBranch() as any[];
			const firstUser = branch.find((e) => e.type === "message" && e.message.role === "user");
			const title = pi.getSessionName() ?? (firstUser ? userText(firstUser.message) : "");
			const now = new Date();
			const rel = `${FOLDER}/${noteName(now, sm.getSessionId(), title)}`;

			await mkdir(join(VAULT_PATH, FOLDER), { recursive: true });
			await writeFile(
				join(VAULT_PATH, rel),
				`---\npi_session: ${sm.getSessionId()}\ncwd: "${sm.getCwd().replace(/"/g, '\\"')}"\ncreated: ${now.toISOString()}\ntags: [pi-session]\n---\n\n`,
				{ flag: "wx" },
			);
			notePath = rel;

			// Backfill: final assistant output of each earlier prompt on this branch.
			let pending: { text: string; at: Date } | undefined;
			for (const e of branch) {
				if (e.type !== "message") continue;
				if (e.message.role === "user") {
					if (pending) await append(pending.text, pending.at);
					pending = undefined;
				}
				const text = assistantText(e.message);
				if (text) pending = { text, at: new Date(e.timestamp) };
			}
			if (pending) await append(pending.text, pending.at);

			pi.appendEntry(ENTRY, { notePath });
			setStatus(ctx);
			ctx.ui.notify(`Rendering to ${VAULT}/${rel}`, "info");
			await open(ctx);
			fixGremlins(ctx);
		},
	});
}
