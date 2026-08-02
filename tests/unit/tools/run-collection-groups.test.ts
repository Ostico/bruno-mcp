/**
 * The tool layer's job here is translation: what a caller writes in the schema
 * must reach `executeCollection` unchanged. Running a real collection would
 * test the executor a second time and say nothing about the translation, so
 * the executor is mocked and its argument is the assertion.
 */
import { registerRunCollectionTool } from '../../../src/tools/run-tools';
import { RequestExecutor } from '../../../src/bruno/request-executor';

jest.mock('../../../src/bruno/request-executor', () => ({
  RequestExecutor: { executeCollection: jest.fn() },
}));

const mockedExecute = RequestExecutor.executeCollection as jest.Mock;

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

let handler: Handler;
let inputSchema: Record<string, { parse: (v: unknown) => unknown }>;

beforeEach(() => {
  mockedExecute.mockReset();
  mockedExecute.mockResolvedValue({ summary: { total: 0 }, groups: [] });

  const registerTool = jest.fn(
    (_name: string, config: { inputSchema: typeof inputSchema }, fn: Handler) => {
      inputSchema = config.inputSchema;
      handler = fn;
    },
  );
  registerRunCollectionTool({ server: { registerTool } } as never);
});

describe('passing groups through', () => {
  it('hands the group list to the executor unchanged', async () => {
    const groups = [
      { name: 'alice', requests: ['auth/login.bru'], variables: { user: 'alice' } },
      { name: 'bob', requests: ['auth/login.bru'], environment: 'staging', parallel: true },
    ];

    await handler({ collectionPath: '/c', groups });

    expect(mockedExecute).toHaveBeenCalledWith('/c', expect.objectContaining({ groups }));
  });

  it('hands an ordered top-level selection through as `requests`', async () => {
    await handler({ collectionPath: '/c', requests: ['b.bru', 'a.bru'] });

    // Order is the caller's, so it must survive the tool layer intact.
    expect(mockedExecute).toHaveBeenCalledWith(
      '/c',
      expect.objectContaining({ requests: ['b.bru', 'a.bru'] }),
    );
  });

  it('passes maxConcurrency through, including 0 for unbounded', async () => {
    await handler({ collectionPath: '/c', maxConcurrency: 0 });

    expect(mockedExecute).toHaveBeenCalledWith('/c', expect.objectContaining({ maxConcurrency: 0 }));
  });
});

describe('rejecting contradictory input', () => {
  it('refuses both a top-level selection and groups, naming both', async () => {
    const result = await handler({
      collectionPath: '/c',
      requests: ['a.bru'],
      groups: [{ requests: ['b.bru'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('requests');
    expect(result.content[0]!.text).toContain('groups');
    expect(mockedExecute).not.toHaveBeenCalled();
  });
});

describe('a group that lists no requests', () => {
  it('passes the containment scan rather than tripping over an absent list', async () => {
    // The scan walks every group's references; a group that omits the key has
    // none to walk, and reading through the absent list would fail the call
    // before the run started.
    await handler({ collectionPath: '/c', groups: [{ name: 'everything' }] });

    expect(mockedExecute).toHaveBeenCalledWith(
      '/c',
      expect.objectContaining({ groups: [{ name: 'everything' }] }),
    );
  });
});

describe('rejecting variables a placeholder could never reference', () => {
  // A group's variables are normalised at the tool layer, and a name no
  // `{{placeholder}}` can name is refused rather than accepted and silently
  // unusable. Diagnosing that from a run report means reading a 401 and
  // guessing; refusing before the run names the group and the variable.
  it('names the group and the variable, and runs nothing', async () => {
    const result = await handler({
      collectionPath: '/c',
      groups: [
        { name: 'alice', requests: ['a.bru'], variables: { ' user': 'alice' } },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('alice');
    expect(result.content[0]!.text).toContain('whitespace');
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('addresses a group with no name by its index', async () => {
    const result = await handler({
      collectionPath: '/c',
      groups: [
        { requests: ['a.bru'] },
        { requests: ['b.bru'], variables: { 'to{ken}': 'x' } },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/group 1|groups\[1\]/);
    expect(mockedExecute).not.toHaveBeenCalled();
  });
});

describe('containing collectionRoot', () => {
  // `collectionRoot` names the collection that `collectionPath` belongs to: it
  // exists so a run scoped to a subfolder still resolves environments, and the
  // collection- and folder-level SCRIPTS under it are executed. Pointed
  // somewhere else it runs another directory's root scripts against this
  // collection's requests, which is the one path here that executes code the
  // caller did not name.
  it('refuses a collectionRoot that does not contain the collection path', async () => {
    const result = await handler({ collectionPath: '/c/sub', collectionRoot: '/elsewhere' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('collectionRoot');
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('refuses a collectionRoot with a traversal in it', async () => {
    const result = await handler({ collectionPath: '/c', collectionRoot: '/c/../../etc' });

    expect(result.isError).toBe(true);
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('accepts an ancestor, which is what it is for', async () => {
    await handler({ collectionPath: '/c/sub/deeper', collectionRoot: '/c' });

    expect(mockedExecute).toHaveBeenCalledWith(
      '/c/sub/deeper',
      expect.objectContaining({ collectionRoot: '/c' }),
    );
  });

  it('accepts the collection path itself', async () => {
    await handler({ collectionPath: '/c', collectionRoot: '/c' });

    expect(mockedExecute).toHaveBeenCalled();
  });

  it('is not required', async () => {
    await handler({ collectionPath: '/c' });

    expect(mockedExecute).toHaveBeenCalled();
  });
});

describe('the arguments that no longer exist', () => {
  it.each(['requestPath', 'folder'])('does not accept %s', (name) => {
    // Not merely absent from the docs: zod strips an unknown key silently, and
    // a stripped subset argument runs the whole collection while looking like a
    // subset. The schema must not carry these at all.
    expect(inputSchema).not.toHaveProperty(name);
  });
});
