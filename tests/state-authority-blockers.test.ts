import { vi } from "vitest";

// The legacy blocker suite exercises Integration replay/deletion state transitions with a synthetic
// deployment fixture. Isolate that transport fixture behind the new run-witness provider; dedicated
// integration-authority-root tests exercise the real protected-witness verifier and prove
// Deployments/Deployment Statuses are non-authoritative.
vi.mock("../src/core/integration-run-witness.js", () => {
  class IntegrationRunWitnessDiscoveryPendingError extends Error {}
  return {
    IntegrationRunWitnessDiscoveryPendingError,
    findEarliestProtectedIntegrationRunWitness: vi.fn(async (github: any) => {
      const deployments = [...(github.__deployments ?? [])].sort((left: any, right: any) => right.id - left.id);
      const matches: Array<{ id: number; createdAt: string }> = [];
      for (let page = 1; ; page += 1) {
        await github.__hooks?.onDeploymentPage?.(page);
        const pageItems = deployments.slice((page - 1) * 100, page * 100);
        for (const deployment of pageItems) {
          for (const status of deployment.statuses ?? []) {
            const match = String(status.environment_url ?? "").match(/\/actions\/runs\/(\d+)(?:\?|$)/);
            const id = Number(match?.[1]);
            if (Number.isSafeInteger(id) && id > 0) matches.push({ id, createdAt: deployment.created_at });
          }
        }
        if (pageItems.length < 100) break;
      }
      const earliest = matches.sort((left, right) => left.id - right.id)[0];
      return earliest ? {
        id: earliest.id,
        attempt: 1 as const,
        created_at: earliest.createdAt,
        html_url: `https://github.com/${github.repository.fullName}/actions/runs/${earliest.id}`,
      } : undefined;
    }),
  };
});

await import("./state-authority-blockers-legacy.js");
