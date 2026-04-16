import { describe, expect, it, vi } from "vitest";

import type { CloudAuthProvider } from "../../../src/cloud/cloud-auth-provider";
import { CloudCapabilitiesHttpClient, parseCapabilitiesResponse } from "../../../src/cloud/cloud-capabilities-client";

function createAuthProvider(token = "sk_test"): CloudAuthProvider {
	return {
		getAuthHeaders: async () => ({ Authorization: `Bearer ${token}` }),
	};
}

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("CloudCapabilitiesHttpClient", () => {
	it("sends a Bearer token and X-Service-Name header to the capabilities endpoint", async () => {
		const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			okResponse({
				success: true,
				data: { cloudAgentAllowed: true, reason: "internal_user" },
			}),
		);
		const client = new CloudCapabilitiesHttpClient({
			baseUrl: "https://core.example.com/",
			authProvider: createAuthProvider("sk_live_abc"),
			fetch: fetchFn,
		});

		const result = await client.getCloudAgentCapability();

		expect(result).toEqual({ cloudAgentAllowed: true, reason: "internal_user" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const firstCall = fetchFn.mock.calls[0];
		if (!firstCall) {
			throw new Error("expected fetch to be called at least once");
		}
		const [url, init] = firstCall;
		expect(url).toBe("https://core.example.com/api/v2/cloud-platform/capabilities");
		expect(init?.method).toBe("GET");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk_live_abc");
		expect(headers["X-Service-Name"]).toBe("kanban");
	});

	it("unwraps core-api success envelopes", () => {
		expect(
			parseCapabilitiesResponse({
				success: true,
				data: { cloudAgentAllowed: false, reason: "not_internal" },
			}),
		).toEqual({ cloudAgentAllowed: false, reason: "not_internal" });
	});

	it("throws for envelopes with success=false", () => {
		expect(() => parseCapabilitiesResponse({ success: false, error: "forbidden" })).toThrowError(/forbidden/);
	});

	it("accepts a raw capability payload without an envelope", () => {
		expect(parseCapabilitiesResponse({ cloudAgentAllowed: true, reason: "" })).toEqual({
			cloudAgentAllowed: true,
			reason: "",
		});
	});

	it("rejects a payload missing cloudAgentAllowed", () => {
		expect(() => parseCapabilitiesResponse({ reason: "oops" })).toThrowError(/cloudAgentAllowed must be boolean/);
	});

	it("surfaces HTTP non-2xx responses as errors", async () => {
		const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("nope", { status: 500 }));
		const client = new CloudCapabilitiesHttpClient({
			baseUrl: "https://core.example.com",
			authProvider: createAuthProvider(),
			fetch: fetchFn,
		});
		await expect(client.getCloudAgentCapability()).rejects.toThrow(/HTTP 500/);
	});
});
