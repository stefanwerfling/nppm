import {
    ApiDepGraphResponse,
    ApiFingerprintDiffResponse,
    ApiFingerprintResponse,
    ApiHistoryResponse,
    ApiLockfileResponse,
    ApiMatrixHeuristicsRequest,
    ApiMatrixHeuristicsResponse,
    ApiMatrixSecurityRequest,
    ApiMatrixSecurityResponse,
    ApiPackagesResponse,
    ApiProjectMatrixResponse,
    ApiProjectsResponse,
    ApiReleasesResponse,
    ApiSecurityResponse
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

    public static async listPackages(projectUnid: string): Promise<ApiPackagesResponse> {
        return Api._json<ApiPackagesResponse>(`/api/projects/${projectUnid}/packages`);
    }

    public static async lockfile(projectUnid: string): Promise<ApiLockfileResponse> {
        return Api._json<ApiLockfileResponse>(`/api/projects/${projectUnid}/lockfile`);
    }

    public static async history(projectUnid: string): Promise<ApiHistoryResponse> {
        return Api._json<ApiHistoryResponse>(`/api/projects/${projectUnid}/history`);
    }

    public static async projectMatrix(projectUnid: string): Promise<ApiProjectMatrixResponse> {
        return Api._json<ApiProjectMatrixResponse>(`/api/projects/${projectUnid}/matrix`);
    }

    public static async depGraph(projectUnid: string): Promise<ApiDepGraphResponse> {
        return Api._json<ApiDepGraphResponse>(`/api/projects/${projectUnid}/depgraph`);
    }

    public static async releases(name: string): Promise<ApiReleasesResponse> {
        const qs = new URLSearchParams({name});
        return Api._json<ApiReleasesResponse>(`/api/releases?${qs.toString()}`);
    }

    public static async matrix(): Promise<MatrixResponse> {
        return Api._json<MatrixResponse>('/api/matrix');
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