import { z } from "zod";

// ---------------------------------------------------------------------------
// Cloud Instance States (cloud-platform)
// ---------------------------------------------------------------------------

/**
 * States reported by cloud-platform for a provisioned instance.
 *
 * These are the **cloud-platform-side** states returned by
 * `GET /instances/{instance_id}`.  They are distinct from the Kanban
 * lifecycle states defined in `cloud-execution-lifecycle.ts`.
 *
 * Source: PRD Section 4 (Sandbox Lifecycle) + Section 15.5 code-grounded
 * reconciliation notes listing the current API values:
 *   provisioning, starting, ready, unhealthy, failed
 *
 * The PRD Section 4 diagram also defines the target states:
 *   requested, creating, ready, executing, stopping, terminated
 *
 * We accept both the currently verified API values and the target values
 * so the client is forward-compatible without breaking existing behaviour.
 */
export const cloudInstanceStateSchema = z.enum([
	// Currently verified cloud-platform API values (Section 15.5 notes)
	"provisioning",
	"starting",
	"ready",
	"unhealthy",
	"failed",
	// Target lifecycle values from PRD Section 4
	"requested",
	"creating",
	"executing",
	"stopping",
	"terminated",
]);
export type CloudInstanceState = z.infer<typeof cloudInstanceStateSchema>;

// ---------------------------------------------------------------------------
// Instance Response Schema
// ---------------------------------------------------------------------------

/**
 * Minimal schema for the instance object returned by
 * `GET /instances/{instance_id}`.
 *
 * Only the fields required by the readiness poller and state mapper are
 * included.  Additional fields from the cloud-platform response are
 * intentionally left uncaptured (open schema) so the client is not
 * brittle against upstream additions.
 */
export const cloudInstanceResponseSchema = z.object({
	instance_id: z.string().min(1),
	state: cloudInstanceStateSchema,
	hostname: z.string().optional(),
});
export type CloudInstanceResponse = z.infer<typeof cloudInstanceResponseSchema>;

// ---------------------------------------------------------------------------
// Client Interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the Kanban-side cloud-platform instance client.
 *
 * This follows the MVP Bridge API contract (PRD Section 5.4):
 *   - POST /instances/          → createInstance
 *   - GET  /instances/{id}      → getInstance
 *   - DELETE /instances/{id}    → deleteInstance
 *
 * B1 implements the full client.  B2 only requires `getInstance` for
 * readiness polling, but the full interface is declared here so B1 and B2
 * share one contract.
 */
export interface CloudInstanceClient {
	getInstance(instanceId: string, signal?: AbortSignal): Promise<CloudInstanceResponse>;
}
