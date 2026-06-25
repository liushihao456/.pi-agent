export interface KeyedAsyncPreviewRenderControls {
	isLatest: () => boolean;
	yieldIfStale: () => Promise<boolean>;
}

export interface KeyedAsyncPreviewRenderOptions<T> {
	state: Record<string, any> | undefined;
	key: string;
	pendingKey: string;
	displayKey?: string;
	pendingTokenKey?: string;
	isCurrent?: () => boolean;
	yieldBeforeRender?: boolean;
	render: (controls?: KeyedAsyncPreviewRenderControls) => Promise<T>;
	commit: (value: T) => void;
	onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object";
}

export function scheduleKeyedAsyncPreviewRender<T>(options: KeyedAsyncPreviewRenderOptions<T>): boolean {
	const state = options.state;
	if (!isRecord(state)) return false;
	const tokenKey = options.pendingTokenKey ?? `${options.pendingKey}Token`;
	if (options.displayKey && state[options.displayKey] === options.key) return false;
	if (state[options.pendingKey] === options.key) return false;

	const token = Symbol(options.key);
	state[options.pendingKey] = options.key;
	state[tokenKey] = token;

	const isLatest = (): boolean => {
		if (state[options.pendingKey] !== options.key) return false;
		if (state[tokenKey] !== token) return false;
		return options.isCurrent ? options.isCurrent() : true;
	};
	const cleanup = (): void => {
		if (state[options.pendingKey] === options.key && state[tokenKey] === token) {
			delete state[options.pendingKey];
			delete state[tokenKey];
		}
	};

	const yieldIfStale = async (): Promise<boolean> => {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		return isLatest();
	};
	const controls: KeyedAsyncPreviewRenderControls = { isLatest, yieldIfStale };

	Promise.resolve()
		.then(async () => {
			if (options.yieldBeforeRender && !(await yieldIfStale())) {
				cleanup();
				return undefined as T;
			}
			return options.render(controls);
		})
		.then((value) => {
			if (!isLatest()) {
				cleanup();
				return;
			}
			options.commit(value);
			cleanup();
		})
		.catch((error) => {
			if (!isLatest()) {
				cleanup();
				return;
			}
			options.onError?.(error);
			cleanup();
		});
	return true;
}
