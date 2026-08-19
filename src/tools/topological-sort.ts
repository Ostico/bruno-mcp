/**
 * Dependency ordering for a batch of requests.
 *
 * A pure algorithm: it never touched instance state, which is why it sits here
 * rather than among the tool registrations it started in.
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
    // An edge naming something absent is reported rather than dropped. Dropping
    // it used to raise the in-degree of a node whose edge had gone, so nothing
    // ever decremented it, the node never became ready, and the caller was told
    // there was a circular dependency between requests that do not depend on
    // each other at all.
    if (!neighbors) {
      return { error: `Dependency names "${dep.from}", which is not one of the requests` };
    }
    if (!inDegree.has(dep.to)) {
      return { error: `Dependency names "${dep.to}", which is not one of the requests` };
    }
    neighbors.push(dep.to);
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
