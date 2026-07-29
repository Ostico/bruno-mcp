/**
 * Dependency ordering for create_crud_requests.
 *
 * Extracted verbatim; it sat among the tool registrations but is a pure
 * algorithm that never touched instance state.
 */



export function topologicalSort(
  names: string[],
  dependencies: Array<{ from: string; to: string }>
): { order?: string[]; error?: string } {
  // Build adjacency list and in-degree map
  const adjacency: Map<string, string[]> = new Map();
  const inDegree: Map<string, number> = new Map();

  for (const name of names) {
    adjacency.set(name, []);
    inDegree.set(name, 0);
  }

  for (const dep of dependencies) {
    // "from" must run before "to", so from → to is an edge
    const neighbors = adjacency.get(dep.from);
    if (neighbors) {
      neighbors.push(dep.to);
    }
    inDegree.set(dep.to, (inDegree.get(dep.to) || 0) + 1);
  }

  // Initialize queue with nodes that have no incoming edges
  const queue: string[] = [];
  for (const name of names) {
    if (inDegree.get(name) === 0) {
      queue.push(name);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);

    for (const neighbor of adjacency.get(node) || []) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (order.length !== names.length) {
    // Cycle detected — find the nodes involved
    const cycleNodes = names.filter(n => !order.includes(n));
    return { error: `Circular dependency detected between: ${cycleNodes.join(', ')}` };
  }

  return { order };
}
