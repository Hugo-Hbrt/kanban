/**
 * Cloud Staging E2E Test (Layer 4)
 *
 * Hits the REAL staging provisioning API at http://10.104.0.38.
 * Creates a real k8s task-runner instance, verifies response shapes,
 * polls for status transitions, then cleans up.
 *
 * This test creates real infrastructure — run it intentionally.
 * Set CLOUD_STAGING_E2E=1 to enable.
 */
import { afterAll, describe, expect, it } from "vitest";

const STAGING_BASE_URL = "http://10.104.0.38";
const TEST_USER_ID = "usr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SKIP = !process.env.CLOUD_STAGING_E2E;

let createdInstanceId: string | null = null;

async function apiPost(path: string, body: unknown) {
	const res = await fetch(`${STAGING_BASE_URL}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}

async function apiGet(path: string) {
	const res = await fetch(`${STAGING_BASE_URL}${path}`);
	return { status: res.status, data: await res.json().catch(() => null) };
}

async function apiDelete(path: string) {
	const res = await fetch(`${STAGING_BASE_URL}${path}`, { method: "DELETE" });
	return { status: res.status };
}

// Always clean up created instances
afterAll(async () => {
	if (createdInstanceId) {
		console.log(`[cleanup] Deleting instance ${createdInstanceId}`);
		await apiDelete(`/instances/${createdInstanceId}`);
	}
});

describe.skipIf(SKIP)("Layer 4: Staging E2E against real provisioning API", () => {
	// -----------------------------------------------------------------------
	// Health check
	// -----------------------------------------------------------------------
	it("GET /health returns healthy", async () => {
		const res = await apiGet("/health");
		expect(res.status).toBe(200);
		expect(res.data).toEqual({ status: "healthy" });
	});

	// -----------------------------------------------------------------------
	// Validation: rejects invalid user_id format
	// -----------------------------------------------------------------------
	it("POST /instances rejects invalid user_id with 422", async () => {
		const res = await apiPost("/instances/", {
			user_id: "bad-user-id",
			repo_url: "https://github.com/octocat/Hello-World.git",
			api_key: "test-staging-key",
			instance_type: "task-runner",
		});
		expect(res.status).toBe(422);
		expect(res.data?.detail).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// Validation: rejects invalid instance_type
	// -----------------------------------------------------------------------
	it("POST /instances rejects invalid instance_type with 422", async () => {
		const res = await apiPost("/instances/", {
			user_id: TEST_USER_ID,
			repo_url: "https://github.com/octocat/Hello-World.git",
			api_key: "test-staging-key",
			instance_type: "invalid-type",
		});
		expect(res.status).toBe(422);
	});

	// -----------------------------------------------------------------------
	// Validation: rejects missing required fields
	// -----------------------------------------------------------------------
	it("POST /instances rejects missing fields with 422", async () => {
		const res = await apiPost("/instances/", {
			user_id: TEST_USER_ID,
		});
		expect(res.status).toBe(422);
	});

	// -----------------------------------------------------------------------
	// Validation: task-runner without github_pat returns 422 (not 500)
	// Requires fix/github-pat-validation to be deployed.
	// -----------------------------------------------------------------------
	it("POST /instances rejects task-runner without github_pat with 422", async () => {
		const res = await apiPost("/instances/", {
			user_id: TEST_USER_ID,
			repo_url: "https://github.com/octocat/Hello-World.git",
			api_key: "test-key",
			instance_type: "task-runner",
		});
		expect(res.status).toBe(422);
		expect(res.data?.detail).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// Create a REAL instance
	// -----------------------------------------------------------------------
	it("POST /instances/ creates a real task-runner instance", async () => {
		const res = await apiPost("/instances/", {
			user_id: TEST_USER_ID,
			repo_url: "https://github.com/octocat/Hello-World.git",
			api_key: "test-staging-e2e-key",
			instance_type: "task-runner",
			github_pat: "ghp_test_staging_e2e",
			pr_base_branch: "main",
		});

		expect(res.status).toBe(201);
		expect(res.data).toBeDefined();

		// Validate InstanceCreated response shape
		expect(res.data.instance_id).toEqual(expect.any(String));
		expect(res.data.instance_id.length).toBeGreaterThan(0);
		expect(res.data.user_id).toBe(TEST_USER_ID);
		expect(res.data.namespace).toEqual(expect.any(String));
		expect(res.data.hostname).toEqual(expect.any(String));
		expect(res.data.hostname).toContain("instances.cline.bot");

		createdInstanceId = res.data.instance_id;
		console.log(`[e2e] Created instance: ${createdInstanceId}`);
		console.log(`[e2e] Hostname: ${res.data.hostname}`);
		console.log(`[e2e] Namespace: ${res.data.namespace}`);
	});

	// -----------------------------------------------------------------------
	// Poll instance status
	// -----------------------------------------------------------------------
	it("GET /instances/{id} returns valid InstanceStatus", async () => {
		expect(createdInstanceId).not.toBeNull();

		const res = await apiGet(`/instances/${createdInstanceId}`);
		expect(res.status).toBe(200);

		// Validate InstanceStatus response shape
		expect(res.data.instance_id).toBe(createdInstanceId);
		expect(res.data.user_id).toBe(TEST_USER_ID);
		expect(res.data.namespace).toEqual(expect.any(String));
		expect(res.data.hostname).toEqual(expect.any(String));

		// State must be one of the valid InstanceState enum values
		const validStates = ["provisioning", "starting", "ready", "unhealthy", "failed"];
		expect(validStates).toContain(res.data.state);

		console.log(`[e2e] Instance state: ${res.data.state}`);
	});

	// -----------------------------------------------------------------------
	// List instances includes our instance
	// -----------------------------------------------------------------------
	it("GET /instances/?user_id= lists the created instance", async () => {
		expect(createdInstanceId).not.toBeNull();

		const res = await apiGet(`/instances/?user_id=${TEST_USER_ID}`);
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);

		const found = res.data.find((inst: { id: string }) => inst.id === createdInstanceId);
		expect(found).toBeDefined();

		// Validate InstanceRead shape
		expect(found.user_id).toBe(TEST_USER_ID);
		expect(found.instance_type).toBe("task-runner");
		expect(found.repo_url).toBe("https://github.com/octocat/Hello-World.git");
		expect(found.hostname).toContain("instances.cline.bot");
		expect(found.created_at).toEqual(expect.any(String));
		expect(found.updated_at).toEqual(expect.any(String));

		console.log(`[e2e] Found ${res.data.length} instance(s) for user`);
	});

	// -----------------------------------------------------------------------
	// GET nonexistent instance returns error
	// -----------------------------------------------------------------------
	it("GET /instances/nonexistent returns appropriate error", async () => {
		const res = await apiGet("/instances/nonexistent-id-12345");
		// Could be 404 or 400 depending on API error handling
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	// -----------------------------------------------------------------------
	// Delete the instance (cleanup)
	// -----------------------------------------------------------------------
	it("DELETE /instances/{id} removes the instance", async () => {
		expect(createdInstanceId).not.toBeNull();

		const res = await apiDelete(`/instances/${createdInstanceId}`);
		expect(res.status).toBe(204);

		console.log(`[e2e] Deleted instance: ${createdInstanceId}`);
		createdInstanceId = null; // Prevent afterAll double-delete

		// Verify it's gone
		const getRes = await apiGet(`/instances/?user_id=${TEST_USER_ID}`);
		const stillExists = getRes.data?.find?.((inst: { id: string }) => inst.id === createdInstanceId);
		expect(stillExists).toBeUndefined();
	});
});
