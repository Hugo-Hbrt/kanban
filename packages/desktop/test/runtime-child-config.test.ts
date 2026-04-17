import { describe, expect, it } from "vitest";
import type { RuntimeChildConfig } from "../src/runtime-child-config.js";

describe("RuntimeChildConfig", () => {
	it("accepts a valid config", () => {
		const config: RuntimeChildConfig = {
			host: "127.0.0.1",
			port: 3484,
		};
		expect(config.host).toBe("127.0.0.1");
		expect(config.port).toBe(3484);
	});
});
