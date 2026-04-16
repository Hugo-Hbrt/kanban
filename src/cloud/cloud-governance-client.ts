// ---------------------------------------------------------------------------
// Cloud Governance Client — type stub
// ---------------------------------------------------------------------------
//
// The governance layer (core-api /api/v1/execution/authorize, /usage/reservations,
// /usage/events, /audit/events) was removed when the execution-plane architecture
// was simplified to CLINE_API_KEY auth + direct kanban→pod polling.
//
// This file is kept as a type-only stub so that `cloud-execution-orchestrator`
// and related modules that accept a `GovernanceClient | null` still typecheck.
// The bootstrap always passes `null`, and the orchestrator's null-guarded
// governance branches become no-ops.
//
// If a governance layer is reintroduced later, re-implement GovernanceClient
// here and wire it back into the bootstrap.
// ---------------------------------------------------------------------------

import { z } from "zod";

export const executionContextSchema = z.object({
	repoUrl: z.string().optional().default(""),
	baseBranch: z.string().optional().default(""),
	featureBranchIntent: z.string().optional().default(""),
	worktreeIntent: z.string().optional().default(""),
});
export type ExecutionContext = z.infer<typeof executionContextSchema>;

export const taskSpecSchema = z.object({
	type: z.string().min(1),
	image: z.string().min(1),
	tools: z.array(z.string()).optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const requestedLimitsSchema = z.object({
	maxComputeSeconds: z.number().int().positive(),
	maxTokenBudget: z.number().int().positive(),
});
export type RequestedLimits = z.infer<typeof requestedLimitsSchema>;

export type AuthorizeRequest = {
	orgId: string;
	userId: string;
	projectId: string;
	taskId: string;
	executionMode: string;
	taskSpec: TaskSpec;
	requestedLimits: RequestedLimits;
	executionContext?: ExecutionContext;
};

export type AuthorizeResponse = {
	decision: "authorized" | "denied";
	reason?: string;
	policySnapshotId?: string;
};

export type ReserveBudgetRequest = {
	taskId: string;
	orgId: string;
	maxComputeSeconds: number;
	maxTokenBudget: number;
	maxCostUsd: number;
	executionMode?: string;
	executionContext?: ExecutionContext;
};

export type ReserveBudgetResponse = {
	reservationId: string;
	expiresAt: string;
};

export type UsageEventRequest = {
	taskId: string;
	orgId: string;
	userId: string;
	executionMode: string;
	cpuSeconds?: number;
	memoryGbSeconds?: number;
	tokensIn?: number;
	tokensOut?: number;
	storageGbHours?: number;
	costUsd?: number;
	reservationId?: string;
	idempotencyKey?: string;
	executionContext?: ExecutionContext;
};

export type UsageEventResponse = {
	accepted: boolean;
	eventId?: string;
	duplicate?: boolean;
	budgetWarning?: string;
};

export type AuditActor = {
	type: "user" | "system" | string;
	id: string;
};

export type AuditResource = {
	type: string;
	id: string;
};

export type AuditEventRequest = {
	actor: AuditActor;
	action: string;
	resource: AuditResource;
	result: "success" | "failure" | string;
	taskId?: string;
	orgId?: string;
	userId?: string;
	projectId?: string;
	metadata?: Record<string, unknown>;
};

export type AuditEventResponse = {
	accepted: boolean;
	eventId?: string;
};

export interface GovernanceClient {
	checkAuthorization(request: AuthorizeRequest, signal?: AbortSignal): Promise<AuthorizeResponse>;
	reserveBudget(request: ReserveBudgetRequest, signal?: AbortSignal): Promise<ReserveBudgetResponse>;
	reportUsage(request: UsageEventRequest, signal?: AbortSignal): Promise<UsageEventResponse>;
	reportAudit(request: AuditEventRequest, signal?: AbortSignal): Promise<AuditEventResponse>;
}
