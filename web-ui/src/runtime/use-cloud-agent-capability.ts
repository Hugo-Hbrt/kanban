import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface CloudAgentCapability {
	readonly cloudAgentAllowed: boolean;
	readonly reason: string;
	readonly configured: boolean;
}

export interface UseCloudAgentCapabilityResult {
	capability: CloudAgentCapability | null;
	isLoading: boolean;
	refresh: () => void;
}

async function fetchCloudAgentCapability(workspaceId: string | null): Promise<CloudAgentCapability> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getCloudAgentCapability.query();
}

// Determines whether the current user can see/use the Cloud agent execution
// mode in the task create/edit dialogs. Backed by GET /api/v2/cloud-platform/
// capabilities on core-api. Result is cached for the session; refresh() forces
// a re-fetch (used when the user signs in/out).
//
// Failure semantics: returns `configured: true, cloudAgentAllowed: false` if
// core-api is reachable but denies the user; returns `configured: false` if
// cloud execution isn't wired up in this deployment. UI treats both as "hide
// the Cloud agent toggle" — the reason string differs only for diagnostics.
export function useCloudAgentCapability(workspaceId: string | null): UseCloudAgentCapabilityResult {
	const queryFn = useCallback(async () => await fetchCloudAgentCapability(workspaceId), [workspaceId]);
	const query = useTrpcQuery<CloudAgentCapability>({
		enabled: true,
		queryFn,
	});

	const refresh = useCallback(() => {
		void query.refetch();
	}, [query.refetch]);

	return {
		capability: query.data,
		isLoading: query.isLoading && query.data === null,
		refresh,
	};
}
