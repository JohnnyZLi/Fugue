export interface DependencyNode {
  issueNumber: number;
  dependencies: number[];
}

export interface DependencyCycle {
  cycle: number[];
}

export function findDependencyCycle(nodes: DependencyNode[]): DependencyCycle | null {
  const graph = new Map<number, number[]>();
  for (const node of nodes) {
    graph.set(node.issueNumber, [...node.dependencies]);
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const path: number[] = [];

  const visit = (issue: number): number[] | null => {
    if (visiting.has(issue)) {
      const start = path.indexOf(issue);
      return [...path.slice(start), issue];
    }
    if (visited.has(issue)) return null;

    visiting.add(issue);
    path.push(issue);

    for (const dependency of graph.get(issue) ?? []) {
      if (dependency === issue) return [issue, issue];
      if (!graph.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    path.pop();
    visiting.delete(issue);
    visited.add(issue);
    return null;
  };

  for (const issue of graph.keys()) {
    const cycle = visit(issue);
    if (cycle) return { cycle };
  }

  return null;
}

export function assertAcyclicDependencies(nodes: DependencyNode[]): void {
  const cycle = findDependencyCycle(nodes);
  if (cycle) {
    throw new Error(`Dependency cycle detected: ${cycle.cycle.map((n) => `#${n}`).join(" -> ")}`);
  }
}
