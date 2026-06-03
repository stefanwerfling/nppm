import {
    ApiAddTemplateSourceResponse,
    ApiBulkUpgradePick,
    ApiBulkUpgradePreviewRequest,
    ApiBulkUpgradePreviewResponse,
    ApiTemplatesResponse,
    ApiCacheClearResponse,
    ApiDepGraphResponse,
    ApiFingerprintDiffResponse,
    ApiFingerprintResponse,
    ApiHistoryResponse, ApiImpactResponse,
    ApiLockfileResponse,
    ApiBundlesRequest,
    ApiBundlesResponse,
    ApiProjectConfigResponse,
    ApiProjectMutationRequest,
    ApiProjectMutationResponse,
    ApiMatrixHeuristicsRequest,
    ApiMatrixHeuristicsResponse,
    ApiMatrixIntegrityResponse,
    ApiMatrixSecurityRequest,
    ApiMatrixSecurityResponse,
    ApiPackagesResponse,
    ApiProjectMatrixResponse,
    ApiProjectsResponse,
    ApiLifecycleScriptsResponse,
    ApiReleasesResponse,
    ApiSecurityResponse,
    ApiUnusedResponse,
    ApiUpgradePreviewResponse,
    ApiUpgradeRequest,
    ApiVulnerabilityTimelineResponse,
    ApiPrReviewResponse,
    ApiIntegrityResponse
} from '../Api/ApiTypes.js';
import {MatrixResponse} from '../Matrix/MatrixBuilder.js';

/**
 * Thin wrapper around fetch — surfaces non-2xx as thrown errors so
 * components can just `await api.x().catch(...)`.
 */
export class Api {

    public static async listProjects(): Promise<ApiProjectsResponse> {
        return Api._json<ApiProjectsResponse>('/api/projects');
    }

    public static async templates(): Promise<ApiTemplatesResponse> {
        return Api._json<ApiTemplatesResponse>('/api/templates');
    }

    public static async addTemplateSource(url: string): Promise<ApiAddTemplateSourceResponse> {
        const res = await fetch('/api/templates/sources', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({url})
        });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error((j as {msg?: string}).msg ?? `${res.status} ${res.statusText}`);
        }
        return (await res.json()) as ApiAddTemplateSourceResponse;
    }

    public static async clearCache(): Promise<ApiCacheClearResponse> {
        const res = await fetch('/api/cache/clear', {method: 'POST'});
        if (!res.ok) {
            throw new Error(`/api/cache/clear → ${res.status} ${res.statusText}`);
        }
        return (await res.json()) as ApiCacheClearResponse;
    }

    /**
     * Toggle the visibility flag for one project. The matrix excludes
     * hidden projects on its next refresh; the treeview keeps showing
     * them so per-project drill-down keeps working.
     */
    public static async getProjectConfig(unid: string): Promise<ApiProjectConfigResponse> {
        return Api._json<ApiProjectConfigResponse>(`/api/projects/${unid}/config`);
    }

    public static async addProject(body: ApiProjectMutationRequest): Promise<ApiProjectMutationResponse> {
        const res = await fetch('/api/projects', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            throw new Error(`/api/projects → ${res.status} ${res.statusText}`);
        }
        return (await res.json()) as ApiProjectMutationResponse;
    }

    public static async editProject(unid: string, body: ApiProjectMutationRequest): Promise<ApiProjectMutationResponse> {
        const res = await fetch(`/api/projects/${unid}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            throw new Error(`/api/projects/${unid} → ${res.status} ${res.statusText}`);
        }
        return (await res.json()) as ApiProjectMutationResponse;
    }

    public static async setProjectVisibility(unid: string, hidden: boolean): Promise<void> {
        const res = await fetch(`/api/projects/${unid}/visibility`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({hidden})
        });
        if (!res.ok) {
            throw new Error(`/api/projects/${unid}/visibility → ${res.status} ${res.statusText}`);
        }
    }

    public static async listPackages(projectUnid: string): Promise<ApiPackagesResponse> {
        return Api._json<ApiPackagesResponse>(`/api/projects/${projectUnid}/packages`);
    }

    public static async lockfile(projectUnid: string): Promise<ApiLockfileResponse> {
        return Api._json<ApiLockfileResponse>(`/api/projects/${projectUnid}/lockfile`);
    }

    public static async history(projectUnid: string): Promise<ApiHistoryResponse> {
        return Api._json<ApiHistoryResponse>(`/api/projects/${projectUnid}/history`);
    }

    public static historyBackfillUrl(projectUnid: string): string {
        return `/api/projects/${projectUnid}/history/backfill`;
    }

    public static async projectMatrix(projectUnid: string): Promise<ApiProjectMatrixResponse> {
        return Api._json<ApiProjectMatrixResponse>(`/api/projects/${projectUnid}/matrix`);
    }

    public static async depGraph(projectUnid: string): Promise<ApiDepGraphResponse> {
        return Api._json<ApiDepGraphResponse>(`/api/projects/${projectUnid}/depgraph`);
    }

    public static async unused(projectUnid: string): Promise<ApiUnusedResponse> {
        return Api._json<ApiUnusedResponse>(`/api/projects/${projectUnid}/unused`);
    }

    public static async vulnerabilityTimeline(projectUnid: string): Promise<ApiVulnerabilityTimelineResponse> {
        return Api._json<ApiVulnerabilityTimelineResponse>(`/api/projects/${projectUnid}/vulnerability-timeline`);
    }

    public static vulnerabilityTimelineScanUrl(projectUnid: string): string {
        return `/api/projects/${projectUnid}/vulnerability-timeline/scan`;
    }

    public static async integrity(projectUnid: string): Promise<ApiIntegrityResponse> {
        return Api._json<ApiIntegrityResponse>(`/api/projects/${projectUnid}/integrity`);
    }

    public static async prReview(
        projectUnid: string,
        base?: string,
        head?: string
    ): Promise<ApiPrReviewResponse> {
        const qs = new URLSearchParams();
        if (base) {
            qs.set('base', base);
        }
        if (head) {
            qs.set('head', head);
        }
        const suffix = qs.toString();
        const url = `/api/projects/${projectUnid}/pr-review${suffix ? `?${suffix}` : ''}`;
        return Api._json<ApiPrReviewResponse>(url);
    }

    public static async upgradePreview(
        projectUnid: string,
        request: ApiUpgradeRequest
    ): Promise<ApiUpgradePreviewResponse> {
        const res = await fetch(`/api/projects/${projectUnid}/upgrade/preview`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(request)
        });
        if (!res.ok) {
            throw new Error(`/upgrade/preview → ${res.status} ${res.statusText}`);
        }
        return (await res.json()) as ApiUpgradePreviewResponse;
    }

    public static async lifecycleScripts(projectUnid: string): Promise<ApiLifecycleScriptsResponse> {
        return Api._json<ApiLifecycleScriptsResponse>(`/api/projects/${projectUnid}/lifecycle-scripts`);
    }

    /**
     * URL helpers for SSE endpoints. The modal opens an `EventSource`
     * directly so the streaming logic lives in the consumer; this
     * keeps the URL shape in one place.
     */
    public static upgradeApplyUrl(projectUnid: string): string {
        return `/api/projects/${projectUnid}/upgrade/apply`;
    }

    public static lifecycleRunUrl(projectUnid: string): string {
        return `/api/projects/${projectUnid}/lifecycle-scripts/run`;
    }

    public static async matrixUpgradePreview(
        picks: ApiBulkUpgradePick[]
    ): Promise<ApiBulkUpgradePreviewResponse> {
        const body: ApiBulkUpgradePreviewRequest = {picks};
        const res = await fetch('/api/matrix/upgrade/preview', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            throw new Error(`/api/matrix/upgrade/preview → ${res.status} ${res.statusText}`);
        }
        return (await res.json()) as ApiBulkUpgradePreviewResponse;
    }

    public static matrixUpgradeApplyUrl(): string {
        return '/api/matrix/upgrade/apply';
    }

    public static async releases(name: string, version?: string): Promise<ApiReleasesResponse> {
        const qs = new URLSearchParams({name});
        if (version) {
            qs.set('version', version);
        }
        return Api._json<ApiReleasesResponse>(`/api/releases?${qs.toString()}`);
    }

    public static async matrix(): Promise<MatrixResponse> {
        return Api._json<MatrixResponse>('/api/matrix');
    }

    public static async impact(name: string, version?: string): Promise<ApiImpactResponse> {
        const qs = new URLSearchParams({name});
        if (version) {
            qs.set('version', version);
        }
        return Api._json<ApiImpactResponse>(`/api/impact?${qs.toString()}`);
    }

    public static async fingerprint(name: string, version: string): Promise<ApiFingerprintResponse> {
        const qs = new URLSearchParams({name, version});
        return Api._json<ApiFingerprintResponse>(`/api/fingerprint?${qs.toString()}`);
    }

    public static async fingerprintDiff(
        name: string,
        before: string,
        after: string
    ): Promise<ApiFingerprintDiffResponse> {
        const qs = new URLSearchParams({name, before, after});
        return Api._json<ApiFingerprintDiffResponse>(`/api/fingerprint/diff?${qs.toString()}`);
    }

    public static async security(name: string, version: string): Promise<ApiSecurityResponse> {
        const qs = new URLSearchParams({name, version});
        return Api._json<ApiSecurityResponse>(`/api/security?${qs.toString()}`);
    }

    public static async matrixSecurity(
        packages: {name: string; version: string}[]
    ): Promise<ApiMatrixSecurityResponse> {
        const body: ApiMatrixSecurityRequest = {packages};
        const res = await fetch('/api/matrix/security', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            throw new Error(`/api/matrix/security → ${res.status} ${res.statusText}`);
        }

        return (await res.json()) as ApiMatrixSecurityResponse;
    }

    public static async matrixIntegrity(): Promise<ApiMatrixIntegrityResponse> {
        return Api._json<ApiMatrixIntegrityResponse>('/api/matrix/integrity');
    }

    public static async matrixBundles(
        packages: {name: string; version: string}[]
    ): Promise<ApiBundlesResponse> {
        const body: ApiBundlesRequest = {packages};
        const res = await fetch('/api/matrix/bundles', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            throw new Error(`/api/matrix/bundles → ${res.status} ${res.statusText}`);
        }
        return (await res.json()) as ApiBundlesResponse;
    }

    public static async matrixHeuristics(
        packages: {name: string; version: string}[]
    ): Promise<ApiMatrixHeuristicsResponse> {
        const body: ApiMatrixHeuristicsRequest = {packages};
        const res = await fetch('/api/matrix/heuristics', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            throw new Error(`/api/matrix/heuristics → ${res.status} ${res.statusText}`);
        }

        return (await res.json()) as ApiMatrixHeuristicsResponse;
    }

    private static async _json<T>(url: string): Promise<T> {
        const res = await fetch(url);

        if (!res.ok) {
            throw new Error(`${url} → ${res.status} ${res.statusText}`);
        }

        return (await res.json()) as T;
    }
}