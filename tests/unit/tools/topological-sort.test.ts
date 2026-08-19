/**
 * Ordering a batch of requests by what has to be written first.
 *
 * The interesting case is an edge naming something that is not in the batch. It
 * used to be dropped from the adjacency list while still counting towards the
 * in-degree of its target, so nothing could ever decrement that target back to
 * zero and the caller was told there was a circular dependency between requests
 * that do not refer to each other at all.
 */

import { topologicalSort } from '../../../src/tools/topological-sort';

describe('topologicalSort', () => {
  it('puts a dependency before the request that declares it', () => {
    const result = topologicalSort(
      ['Use Token', 'Get Token'],
      [{ from: 'Get Token', to: 'Use Token' }],
    );

    expect(result.error).toBeUndefined();
    expect(result.order).toEqual(['Get Token', 'Use Token']);
  });

  it('keeps input order when nothing depends on anything', () => {
    expect(topologicalSort(['A', 'B', 'C'], []).order).toEqual(['A', 'B', 'C']);
  });

  it('orders a chain of three', () => {
    const result = topologicalSort(
      ['C', 'A', 'B'],
      [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    );

    expect(result.order).toEqual(['A', 'B', 'C']);
  });

  it('reports a cycle, naming the requests caught in it', () => {
    const result = topologicalSort(
      ['A', 'B'],
      [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }],
    );

    expect(result.order).toBeUndefined();
    expect(result.error).toContain('Circular dependency');
    expect(result.error).toContain('A');
    expect(result.error).toContain('B');
  });

  // The regression: 'Absent' is not a request, so its edge was dropped, but
  // 'A' kept the in-degree the dropped edge gave it. 'A' therefore never became
  // ready, and the answer was a circular dependency involving one node.
  it('reports an edge whose source is not one of the requests', () => {
    const result = topologicalSort(['A'], [{ from: 'Absent', to: 'A' }]);

    expect(result.order).toBeUndefined();
    expect(result.error).toContain('Absent');
    expect(result.error).not.toContain('Circular');
  });

  it('reports an edge whose target is not one of the requests', () => {
    const result = topologicalSort(['A'], [{ from: 'A', to: 'Absent' }]);

    expect(result.order).toBeUndefined();
    expect(result.error).toContain('Absent');
  });

  it('orders a diamond, with each request after both of its dependencies', () => {
    const result = topologicalSort(
      ['Top', 'Left', 'Right', 'Bottom'],
      [
        { from: 'Top', to: 'Left' },
        { from: 'Top', to: 'Right' },
        { from: 'Left', to: 'Bottom' },
        { from: 'Right', to: 'Bottom' },
      ],
    );

    const order = result.order!;
    expect(order[0]).toBe('Top');
    expect(order[3]).toBe('Bottom');
    expect(order.indexOf('Left')).toBeLessThan(order.indexOf('Bottom'));
    expect(order.indexOf('Right')).toBeLessThan(order.indexOf('Bottom'));
  });
});
