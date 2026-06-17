import { Text } from "@earendil-works/pi-tui";

let handle: { requestRender: () => void; close: () => void } | null = null;
let textComp: Text | null = null;
let pending = "";

export default function (pi: any) {
	pi.on("message_update", (event: any, ctx: any) => {
		const ame = event.assistantMessageEvent;
		if (!ame) return;

		switch (ame.type) {
			case "toolcall_start": {
				if (ame.partial?.name !== "write") return;
				pending = "";
				textComp = new Text("", 0, 0);
				handle = ctx.ui?.custom?.(textComp);
				break;
			}

			case "toolcall_delta": {
				if (!handle || !textComp) break;
				pending += ame.delta || "";
				const parsed = tryParse(pending);
				if (parsed?.content) {
					const head = parsed.path ? `✍ ${parsed.path}\n` : "";
					const body =
						parsed.content.length > 500
							? parsed.content.slice(0, 500) + "\n…"
							: parsed.content;
					textComp.setText(head + body);
					handle.requestRender();
				}
				break;
			}

			case "toolcall_end": {
				if (!handle || !textComp) break;
				if (ame.toolCall?.name === "write") {
					textComp.setText("✅ done");
					handle.requestRender();
					setTimeout(() => {
						handle?.close();
						handle = null;
						textComp = null;
						pending = "";
					}, 1500);
				}
				break;
			}
		}
	});
}

function tryParse(s: string) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
