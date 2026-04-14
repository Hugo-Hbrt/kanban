// ---------------------------------------------------------------------------
// Cloud Execution Contracts — KB-AUTH-2
// ---------------------------------------------------------------------------
//
// Canonical request/response envelope types for outbound execution and
// governance calls. These types match the cloud-platform API contract and
// ensure Kanban never leaks raw user bearer/session tokens in request bodies.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Execution Create Request (POST /api/v1/executions)
// ---------------------------------------------------------------------------

export const executionCreateRequestSchema = z.object({
	taskId: z.string().min(1),
	attemptNumber: z.number().int().positive(),
	executionMode: z.literal("cloud"),
	orgId: z.string(),
	projectId: z.string(),
	requestedByUserId: z.string(),
	repoUrl: z.string(),
	baseBranch: z.string(),
	featureBranchIntent: z.string(),
	worktreeIntent: z.string(),
});
export type ExecutionCreateRequest = z.infer<typeof executionCreateRequestSchema>;

// ---------------------------------------------------------------------------
// Execution Create Response
// ---------------------------------------------------------------------------

export const executionCreateResponseSchema = z.object({
	executionId: z.string().min(1),
	status: z.literal("queued"),
	taskId: z.string().min(1),
	attemptNumber: z.number().int().positive(),
	createdAt: z.string().min(1),
});
export type ExecutionCreateResponse = z.infer<typeof executionCreateResponseSchema>;

// ---------------------------------------------------------------------------
// Execution Status Response (GET /api/v1/executions/{id})
// ---------------------------------------------------------------------------

export const executionStatusSchema = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
	"canceled",
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const executionResultSchema = z.object({
	outcome: z.string(),
	exitCode: z.number(),
	summary: z.string(),
});

export const executionErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
});

export const executionStatusResponseSchema = z.object({
	executionId: z.string().min(1),
	status: executionStatusSchema,
	taskId: z.string().min(1),
	attemptNumber: z.number().int().positive(),
	requestedByUserId: z.string().min(1),
	orgId: z.string().min(1),
	projectId: z.string().min(1),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	result: executionResultSchema.nullable(),
	error: executionErrorSchema.nullable(),
});
export type ExecutionStatusResponse = z.infer<typeof executionStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Execution Logs Response (GET /api/v1/executions/{id}/logs)
// ---------------------------------------------------------------------------

export const executionLogLineSchema = z.object({
	cursor: z.string(),
	ts: z.string(),
	stream: z.string(),
	message: z.string(),
});

export const executionLogsResponseSchema = z.object({
	executionId: z.string().min(1),
	lines: z.array(executionLogLineSchema),
	nextCursor: z.string().nullable(),
});
export type ExecutionLogsResponse = z.infer<typeof executionLogsResponseSchema>;

// ---------------------------------------------------------------------------
// Governance Authorize Request (canonical contract)
// ---------------------------------------------------------------------------

export const governanceAuthorizeRequestSchema = z.object({
	requestedByUserId: z.string(),
	orgId: z.string(),
	projectId: z.string(),
	taskId: z.string().min(1),
	executionMode: z.literal("cloud"),
	repoUrl: z.string(),
	baseBranch: z.string(),
	featureBranchIntent: z.string(),
	worktreeIntent: z.string(),
});
export type GovernanceAuthorizeRequest = z.infer<typeof governanceAuthorizeRequestSchema>;

// ---------------------------------------------------------------------------
// Builder: Execution Create Request
// ---------------------------------------------------------------------------

export interface ExecutionRequestContext {
	taskId: string;
	attemptNumber: number;
	orgId: string;
	projectId: string;
	userId: string;
	repoUrl: string;
	baseBranch: string;
	featureBranchIntent: string;
	worktreeIntent: string;
}

/**
 * Build a canonical ExecutionCreateRequest from Kanban runtime context.
 * No raw user tokens are included in the body — auth is header-only.
 */
export function buildExecutionCreateRequest(ctx: ExecutionRequestContext): ExecutionCreateRequest {
	return executionCreateRequestSchema.parse({
		taskId: ctx.taskId,
		attemptNumber: ctx.attemptNumber,
		executionMode: "cloud" as const,
		orgId: ctx.orgId,
		projectId: ctx.projectId,
		requestedByUserId: ctx.userId,
		repoUrl: ctx.repoUrl,
		baseBranch: ctx.baseBranch,
		featureBranchIntent: ctx.featureBranchIntent,
		worktreeIntent: ctx.worktreeIntent,
	});
}

/**
 * Build a canonical GovernanceAuthorizeRequest from the same runtime context.
 * No raw user tokens are included in the body — auth is header-only.
 */
export function buildGovernanceAuthorizeRequest(ctx: ExecutionRequestContext): GovernanceAuthorizeRequest {
	return governanceAuthorizeRequestSchema.parse({
		requestedByUserId: ctx.userId,
		orgId: ctx.orgId,
		projectId: ctx.projectId,
		taskId: ctx.taskId,
		executionMode: "cloud" as const,
		repoUrl: ctx.repoUrl,
		baseBranch: ctx.baseBranch,
		featureBranchIntent: ctx.featureBranchIntent,
		worktreeIntent: ctx.worktreeIntent,
	});
}
