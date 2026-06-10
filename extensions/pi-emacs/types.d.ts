declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		on(event: string, handler: (...args: any[]) => any): void;
		registerCommand(
			name: string,
			options: { description?: string; handler: (...args: any[]) => any },
		): void;
		registerShortcut(
			shortcut: string,
			options: { description?: string; handler: (...args: any[]) => any },
		): void;
	}

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		ui: {
			notify(message: string, level?: "info" | "warning" | "error"): void;
			custom<T = unknown>(
				factory: (...args: any[]) => any,
				options?: any,
			): Promise<T>;
		};
	}
}
