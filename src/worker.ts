import { Container } from "@cloudflare/containers";

interface Env {
	GAME_CONTAINER: DurableObjectNamespace<GameContainer>;
	CALLS_APP_ID: string;
	CALLS_APP_TOKEN: string;
}

export class GameContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "10m";
	enableInternet = true;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Must set envVars as own property to override parent's class field
		this.envVars = {
			CALLS_APP_ID: env.CALLS_APP_ID,
			CALLS_APP_TOKEN: env.CALLS_APP_TOKEN,
		};
	}

	override onStart() {
		console.log("GameContainer started");
	}

	override onError(error: unknown) {
		console.error("GameContainer error:", error);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/")) {
			const id = env.GAME_CONTAINER.idFromName("game-world-v12");
			const container = env.GAME_CONTAINER.get(id) as DurableObjectStub<GameContainer>;
			return container.fetch(request);
		}

		return new Response("Not found", { status: 404 });
	},
};
