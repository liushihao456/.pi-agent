import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ComponentRenderInput } from "./type.ts";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_CHARS = 600;

type UsageSource = "pi-auth" | "codex-app-server";
type PiModel = NonNullable<ExtensionContext["model"]>;
type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;

type CodexUsageReport = {
	source: UsageSource;
	capturedAt: number;
	snapshots: NormalizedRateLimitSnapshot[];
};

type NormalizedRateLimitSnapshot = {
	limitId: string;
	limitName?: string;
	primary?: NormalizedRateLimitWindow;
	secondary?: NormalizedRateLimitWindow;
};

type NormalizedRateLimitWindow = {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
};

type BackendRateLimitDetails = {
	primary_window?: unknown;
	secondary_window?: unknown;
};

type BackendWindowSnapshot = {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
};

type BackendAdditionalRateLimit = {
	limit_name?: unknown;
	metered_feature?: unknown;
	rate_limit?: unknown;
};

type BackendPayload = {
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
};

type AppServerRateLimitResponse = {
	rateLimits?: unknown;
	rateLimitsByLimitId?: unknown;
};

type AppServerRateLimitSnapshot = {
	limitId?: unknown;
	limitName?: unknown;
	primary?: unknown;
	secondary?: unknown;
};

type AppServerWindowSnapshot = {
	usedPercent?: unknown;
	windowDurationMins?: unknown;
	resetsAt?: unknown;
};

type RpcResponse = {
	id?: unknown;
	result?: unknown;
	error?: { message?: unknown };
};

type PendingRpc = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

let cachedReport: { createdAt: number; report: CodexUsageReport } | undefined;
let inFlight: Promise<string> | undefined;

export function renderCodexUsageComponent({
	state,
}: ComponentRenderInput): string {
	return state.codexUsageLabel;
}

export function isOpenAICodexModel(
	model: Pick<PiModel, "provider"> | undefined,
): boolean {
	return model?.provider === CODEX_PROVIDER_ID;
}

export async function refreshCodexUsageLabel(
	ctx: ExtensionContext,
	options: { force?: boolean; timeoutMs?: number } = {},
): Promise<string> {
	// Capture session-bound values before any await. During /reload the old
	// ExtensionContext becomes stale while this async refresh may still finish.
	const model = ctx.model;
	if (!isOpenAICodexModel(model)) return "";
	if (inFlight) return inFlight;

	inFlight = (async () => {
		const cached =
			cachedReport && Date.now() - cachedReport.createdAt < 60_000
				? cachedReport
				: undefined;
		if (cached && !options.force) return formatCodexUsage(cached.report, model);

		try {
			const report = await queryUsage(
				ctx,
				model,
				options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			);
			cachedReport = { createdAt: Date.now(), report };
			return formatCodexUsage(report, model);
		} catch {
			return cachedReport
				? formatCodexUsage(cachedReport.report, model)
				: "usage ?";
		}
	})();

	try {
		return await inFlight;
	} finally {
		inFlight = undefined;
	}
}

async function queryUsage(
	ctx: ExtensionContext,
	model: PiModel,
	timeoutMs: number,
): Promise<CodexUsageReport> {
	try {
		return await queryViaPiAuth(ctx, model, timeoutMs);
	} catch {
		return await queryViaCodexAppServer(timeoutMs);
	}
}

async function queryViaPiAuth(
	ctx: ExtensionContext,
	model: PiModel,
	timeoutMs: number,
): Promise<CodexUsageReport> {
	const registry = ctx.modelRegistry;
	const candidates = codexAuthCandidateModels(model, registry);
	const auth = await resolvePiCodexAuth(registry, candidates);
	if (!auth) throw new Error("No Pi OpenAI Codex auth available.");

	const response = await fetchWithTimeout(
		CODEX_USAGE_URL,
		{ headers: auth.headers },
		timeoutMs,
	);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Codex usage endpoint returned ${response.status}: ${redactErrorBody(text)}`,
		);
	}

	return normalizeBackendPayload(
		parseJsonObject(text, "Codex usage endpoint response"),
		Date.now(),
		"pi-auth",
	);
}

async function resolvePiCodexAuth(
	registry: ExtensionContext["modelRegistry"],
	models: PiModel[],
): Promise<{ headers: Record<string, string> } | undefined> {
	for (const model of models) {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		const headers = { ...(auth.headers ?? {}) };
		if (!hasHeader(headers, "Authorization") && auth.apiKey)
			headers.Authorization = `Bearer ${auth.apiKey}`;
		if (!hasHeader(headers, "User-Agent"))
			headers["User-Agent"] = "pi-status-codex-usage";
		if (hasHeader(headers, "Authorization")) return { headers };
	}
	return undefined;
}

function codexAuthCandidateModels(
	currentModel: PiModel,
	modelRegistry: ExtensionContext["modelRegistry"],
): PiModel[] {
	const registry = modelRegistry as ExtensionContext["modelRegistry"] & {
		getAvailable?: () => PiModel[];
		getAll?: () => PiModel[];
	};
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || model.provider !== CODEX_PROVIDER_ID) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};

	add(currentModel);
	for (const model of registry.getAvailable?.() ?? []) add(model);
	for (const model of registry.getAll?.() ?? []) add(model);
	return candidates;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function queryViaCodexAppServer(
	timeoutMs: number,
): Promise<CodexUsageReport> {
	const client = new CodexAppServerClient(timeoutMs);
	try {
		await client.start();
		await client.request("initialize", {
			clientInfo: { name: "pi_status", title: "Pi Status", version: "0.1.0" },
			capabilities: {
				experimentalApi: false,
				requestAttestation: false,
				optOutNotificationMethods: [],
			},
		});
		client.notify("initialized");
		const result = await client.request("account/rateLimits/read", undefined);
		return normalizeAppServerResponse(
			assertObject(result, "account/rateLimits/read result"),
			Date.now(),
		);
	} finally {
		client.dispose();
	}
}

class CodexAppServerClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private stderr = "";
	private readonly pending = new Map<number, PendingRpc>();
	private startPromise?: Promise<void>;
	private exitError?: Error;

	constructor(private readonly timeoutMs: number) {}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise;

		this.startPromise = new Promise((resolve, reject) => {
			const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			const startupTimeout = setTimeout(
				() => reject(new Error("Timed out starting codex app-server.")),
				this.timeoutMs,
			);
			child.once("spawn", () => {
				clearTimeout(startupTimeout);
				resolve();
			});
			child.once("error", (error) => {
				clearTimeout(startupTimeout);
				reject(error);
				this.rejectAll(error);
			});
			child.once("exit", (code, signal) => {
				this.exitError = new Error(
					`codex app-server exited (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${this.stderr ? ` stderr: ${redactErrorBody(this.stderr)}` : ""}`,
				);
				this.rejectAll(this.exitError);
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
			});
			createInterface({ input: child.stdout }).on("line", (line) =>
				this.handleLine(line),
			);
		});

		return this.startPromise;
	}

	request(method: string, params: unknown): Promise<unknown> {
		const child = this.child;
		if (!child?.stdin.writable)
			throw new Error("codex app-server is not running.");
		if (this.exitError) throw this.exitError;

		const id = this.nextId++;
		const payload =
			params === undefined ? { method, id } : { method, id, params };
		const response = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${method}.`));
			}, this.timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
		});
		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return response;
	}

	notify(method: string): void {
		if (this.child?.stdin.writable)
			this.child.stdin.write(`${JSON.stringify({ method })}\n`);
	}

	dispose(): void {
		for (const pending of this.pending.values())
			pending.reject(new Error("codex app-server request cancelled."));
		this.pending.clear();
		const child = this.child;
		if (!child) return;
		child.stdin.end();
		if (!child.killed) child.kill();
		this.child = undefined;
	}

	private handleLine(line: string): void {
		let parsed: RpcResponse;
		try {
			parsed = JSON.parse(line) as RpcResponse;
		} catch {
			return;
		}
		if (typeof parsed.id !== "number") return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);
		if (parsed.error) {
			pending.reject(
				new Error(
					`codex app-server request failed: ${String(parsed.error.message ?? "unknown error")}`,
				),
			);
			return;
		}
		pending.resolve(parsed.result);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

function normalizeBackendPayload(
	payload: BackendPayload,
	capturedAt: number,
	source: UsageSource,
): CodexUsageReport {
	const snapshots: NormalizedRateLimitSnapshot[] = [];
	const primary = normalizeBackendSnapshot(
		"codex",
		undefined,
		payload.rate_limit,
	);
	if (primary) snapshots.push(primary);

	const additional = Array.isArray(payload.additional_rate_limits)
		? payload.additional_rate_limits
		: [];
	for (const item of additional) {
		const limit = assertObject(
			item,
			"additional rate limit",
		) as BackendAdditionalRateLimit;
		const limitId =
			asString(limit.metered_feature) ?? asString(limit.limit_name);
		if (!limitId) continue;
		const snapshot = normalizeBackendSnapshot(
			limitId,
			asString(limit.limit_name),
			limit.rate_limit,
		);
		if (snapshot) snapshots.push(snapshot);
	}

	if (snapshots.length === 0)
		throw new Error("No displayable Codex usage windows.");
	return { source, capturedAt, snapshots };
}

function normalizeBackendSnapshot(
	limitId: string,
	limitName: string | undefined,
	rateLimit: unknown,
): NormalizedRateLimitSnapshot | undefined {
	if (rateLimit === null || rateLimit === undefined) return undefined;
	const details = assertObject(
		rateLimit,
		"rate limit",
	) as BackendRateLimitDetails;
	const primary = normalizeBackendWindow(details.primary_window);
	const secondary = normalizeBackendWindow(details.secondary_window);
	if (!primary && !secondary) return undefined;
	return { limitId, limitName, primary, secondary };
}

function normalizeBackendWindow(
	value: unknown,
): NormalizedRateLimitWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(
		value,
		"rate-limit window",
	) as BackendWindowSnapshot;
	const usedPercent = asNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const limitSeconds = asNumber(window.limit_window_seconds);
	return {
		usedPercent,
		windowMinutes:
			limitSeconds && limitSeconds > 0
				? Math.ceil(limitSeconds / 60)
				: undefined,
		resetsAt: asNumber(window.reset_at),
	};
}

function normalizeAppServerResponse(
	response: AppServerRateLimitResponse,
	capturedAt: number,
): CodexUsageReport {
	const snapshots: NormalizedRateLimitSnapshot[] = [];
	const addSnapshot = (raw: unknown, fallbackId: string) => {
		const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
		if (!snapshot) return;
		const existingIndex = snapshots.findIndex(
			(item) => item.limitId === snapshot.limitId,
		);
		if (existingIndex >= 0)
			snapshots[existingIndex] = { ...snapshots[existingIndex], ...snapshot };
		else snapshots.push(snapshot);
	};

	addSnapshot(response.rateLimits, "codex");
	if (
		response.rateLimitsByLimitId &&
		typeof response.rateLimitsByLimitId === "object"
	) {
		for (const [limitId, raw] of Object.entries(response.rateLimitsByLimitId))
			addSnapshot(raw, limitId);
	}
	if (snapshots.length === 0)
		throw new Error("No displayable Codex usage windows.");
	return { source: "codex-app-server", capturedAt, snapshots };
}

function normalizeAppServerSnapshot(
	raw: unknown,
	fallbackId: string,
): NormalizedRateLimitSnapshot | undefined {
	if (raw === null || raw === undefined) return undefined;
	const snapshot = assertObject(
		raw,
		"app-server rate-limit snapshot",
	) as AppServerRateLimitSnapshot;
	const limitId = asString(snapshot.limitId) ?? fallbackId;
	const primary = normalizeAppServerWindow(snapshot.primary);
	const secondary = normalizeAppServerWindow(snapshot.secondary);
	if (!primary && !secondary) return undefined;
	return {
		limitId,
		limitName: asString(snapshot.limitName),
		primary,
		secondary,
	};
}

function normalizeAppServerWindow(
	value: unknown,
): NormalizedRateLimitWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(
		value,
		"app-server rate-limit window",
	) as AppServerWindowSnapshot;
	const usedPercent = asNumber(window.usedPercent);
	if (usedPercent === undefined) return undefined;
	return {
		usedPercent,
		windowMinutes: asNumber(window.windowDurationMins),
		resetsAt: asNumber(window.resetsAt),
	};
}

function formatCodexUsage(
	report: CodexUsageReport,
	model: CodexUsageModel | undefined,
): string {
	const snapshot = selectSnapshotForModel(report, model);
	if (!snapshot) return "usage ?";
	const parts: string[] = [];
	if (snapshot.primary)
		parts.push(`5h ${formatRemainingPercent(snapshot.primary)}`);
	if (snapshot.secondary)
		parts.push(`wk ${formatRemainingPercent(snapshot.secondary)}`);
	return parts.length > 0 ? parts.join(" ") : "usage ?";
}

function selectSnapshotForModel(
	report: CodexUsageReport,
	model: CodexUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
	const codexSnapshot = report.snapshots.find(isPrimaryCodexSnapshot);
	if (!model || !isOpenAICodexModel(model))
		return codexSnapshot ?? report.snapshots[0];

	const modelKeys = normalizedModelUsageKeys(model);
	const exactMatch = report.snapshots.find((snapshot) =>
		normalizedSnapshotUsageKeys(snapshot).some((key) => modelKeys.has(key)),
	);
	return exactMatch ?? codexSnapshot ?? report.snapshots[0];
}

function isPrimaryCodexSnapshot(
	snapshot: NormalizedRateLimitSnapshot,
): boolean {
	return (
		normalizedUsageKey(snapshot.limitId) === "codex" ||
		normalizedUsageKey(snapshot.limitName) === "codex"
	);
}

function normalizedModelUsageKeys(model: CodexUsageModel): Set<string> {
	const keys = new Set<string>();
	addNormalizedUsageKey(keys, model.id);
	addNormalizedUsageKey(keys, model.name);
	for (const key of [...keys]) {
		const codexIndex = key.indexOf("codex");
		if (codexIndex >= 0) keys.add(key.slice(codexIndex));
	}
	return keys;
}

function normalizedSnapshotUsageKeys(
	snapshot: NormalizedRateLimitSnapshot,
): string[] {
	return [
		normalizedUsageKey(snapshot.limitId),
		normalizedUsageKey(snapshot.limitName),
	].filter((key): key is string => key !== undefined);
}

function addNormalizedUsageKey(
	keys: Set<string>,
	value: string | undefined,
): void {
	const key = normalizedUsageKey(value);
	if (key) keys.add(key);
}

function normalizedUsageKey(value: string | undefined): string | undefined {
	const key = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return key || undefined;
}

function formatRemainingPercent(window: NormalizedRateLimitWindow): string {
	return `${(100 - clampPercent(window.usedPercent)).toFixed(0)}%`;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function parseJsonObject(
	text: string,
	description: string,
): Record<string, unknown> {
	try {
		return assertObject(JSON.parse(text) as unknown, description);
	} catch (error) {
		throw new Error(
			`${description} was not valid JSON: ${errorMessage(error)}`,
		);
	}
}

function assertObject(
	value: unknown,
	description: string,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${description} was not an object.`);
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some(
		(key) => key.toLowerCase() === name.toLowerCase(),
	);
}

function redactErrorBody(body: string): string {
	return truncateEnd(
		body
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
			.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
			.trim(),
		MAX_ERROR_BODY_CHARS,
	);
}

function truncateEnd(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
