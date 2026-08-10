/**
 * What `run_collection` tells an agent about the two new transports, and what it
 * does with the bounds the agent sets.
 *
 * A tool description is the only documentation an agent ever reads: it cannot open
 * the README and it cannot read the source. So a description that disagrees with
 * the code is worse than no description, and two claims are checked against the
 * code here rather than against my memory of it.
 *
 * The first is the defaults. Every bound's schema default is asserted equal to the
 * constant the transport actually applies, so the two cannot drift apart silently.
 * The second is the parse-failure sentence, which was flatly wrong: it promised
 * that an unparseable file is always skipped, when a file the caller NAMED fails
 * that caller's group instead. The behaviour is proven in run-plan.test.ts ("records
 * a named request that will not parse as that group's error", and the sibling test
 * that keeps the other groups); what is proven here is that the description now says
 * the same thing.
 */
import { registerRunCollectionTool } from '../../../src/tools/run-tools';
import { RequestExecutor } from '../../../src/bruno/request-executor';
import {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SEND_INTERVAL_MS,
} from '../../../src/bruno/ws-transport';
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
} from '../../../src/bruno/transport-redaction';

jest.mock('../../../src/bruno/request-executor', () => ({
  RequestExecutor: { executeCollection: jest.fn() },
}));

const mockedExecute = RequestExecutor.executeCollection as jest.Mock;

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

interface Checker {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
}

let handler: Handler;
let inputSchema: Record<string, Checker>;
let description: string;

beforeEach(() => {
  mockedExecute.mockReset();
  mockedExecute.mockResolvedValue({ summary: { total: 0 }, groups: [] });

  const registerTool = jest.fn(
    (_name: string, config: { inputSchema: typeof inputSchema; description: string }, fn: Handler) => {
      inputSchema = config.inputSchema;
      description = config.description;
      handler = fn;
    },
  );
  registerRunCollectionTool({ server: { registerTool } } as never);
});

/** The reasons a rejected bound gives, flattened for assertion. */
function reasonsFor(value: unknown): string[] {
  const outcome = inputSchema.websocket!.safeParse(value);
  expect(outcome.success).toBe(false);
  return (outcome.error?.issues ?? []).map((issue) => issue.message);
}

// Every bound below rejects an out-of-range value BY NAME. A misspelled key used
// to be accepted and then ignored, silently restoring the default — so the one
// mistake that produced no diagnostic at all was the one a typo makes.
describe('an unknown websocket option key', () => {
  it('is rejected rather than ignored', () => {
    const outcome = inputSchema.websocket!.safeParse({ maxMessages: 3, bogusOption: true });
    expect(outcome.success).toBe(false);
  });

  it('names the key it did not recognise', () => {
    expect(reasonsFor({ maxMessage: 3 }).join(' ')).toMatch(/maxMessage/);
  });

  it('still accepts every key the transport really honours', () => {
    const everyKey = {
      maxMessages: 10,
      maxDurationMs: 1000,
      idleTimeoutMs: 90,
      sendIntervalMs: 25,
      includePayloads: true,
      maxFrameBytes: 128,
      maxTranscriptBytes: 4096,
      engineIoKeepalive: true,
    };
    expect(inputSchema.websocket!.parse(everyKey)).toEqual(everyKey);
  });
});

describe('the websocket bounds a caller can set', () => {
  it('defaults every bound to the value the transport actually applies', () => {
    // Asserted against the transport's own constants, not against literals: a
    // schema that documents 50 while the transport uses 200 is a lie an agent
    // cannot detect, and two literals would agree with each other forever.
    expect(inputSchema.websocket!.parse({})).toEqual({
      maxMessages: DEFAULT_MAX_MESSAGES,
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      sendIntervalMs: DEFAULT_SEND_INTERVAL_MS,
      includePayloads: false,
      maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
      maxTranscriptBytes: DEFAULT_MAX_TRANSCRIPT_BYTES,
      engineIoKeepalive: false,
    });
  });

  it('keeps payload recording and the keepalive reply off unless asked', () => {
    // Both are stated separately from the defaults above because both are
    // security properties rather than preferences: payloads are post-substitution
    // and would carry supplied secrets, and the keepalive puts a frame on the
    // wire the request did not author.
    const parsed = inputSchema.websocket!.parse({ maxMessages: 3 }) as Record<string, unknown>;
    expect(parsed.includePayloads).toBe(false);
    expect(parsed.engineIoKeepalive).toBe(false);
  });

  it('accepts a full set of bounds', () => {
    const supplied = {
      maxMessages: 5,
      maxDurationMs: 1500,
      idleTimeoutMs: 250,
      sendIntervalMs: 100,
      includePayloads: true,
      maxFrameBytes: 1024,
      maxTranscriptBytes: 4096,
      engineIoKeepalive: true,
    };
    expect(inputSchema.websocket!.parse(supplied)).toEqual(supplied);
  });

  // Zero is the off switch for the idle bound, and every other bound here rejects
  // it: a schema that treated this one the same way would leave no way to ask for
  // the wall-clock ceiling a protocol with long gaps needs.
  it('accepts the idle bound switched off', () => {
    expect(inputSchema.websocket!.parse({ idleTimeoutMs: 0 }).idleTimeoutMs).toBe(0);
  });

  it('refuses a message count outside the range, naming the bound', () => {
    expect(reasonsFor({ maxMessages: 0 }).join(' ')).toMatch(/maxMessages must be at least 1/);
    expect(reasonsFor({ maxMessages: 1001 }).join(' ')).toMatch(/maxMessages must be at most 1000/);
  });

  it('refuses a duration outside the range, naming the bound', () => {
    expect(reasonsFor({ maxDurationMs: 99 }).join(' ')).toMatch(/maxDurationMs must be at least 100/);
    expect(reasonsFor({ maxDurationMs: 60001 }).join(' '))
      .toMatch(/maxDurationMs must be at most 60000/);
  });

  it('refuses byte ceilings outside the range, naming the bound', () => {
    expect(reasonsFor({ maxFrameBytes: 0 }).join(' ')).toMatch(/maxFrameBytes must be at least 1/);
    expect(reasonsFor({ maxTranscriptBytes: 8388609 }).join(' '))
      .toMatch(/maxTranscriptBytes must be at most 8388608/);
  });

  it('refuses a fractional count rather than rounding it', () => {
    // Half a message is not a smaller bound, it is a caller who meant something
    // else, and silently flooring it would run a session they did not ask for.
    expect(reasonsFor({ maxMessages: 2.5 }).length).toBeGreaterThan(0);
  });
});

describe('the bounds reach the executor', () => {
  it('hands the whole object through unchanged', async () => {
    const websocket = { maxMessages: 2, includePayloads: true };
    await handler({ collectionPath: '/c', websocket });

    expect(mockedExecute).toHaveBeenCalledWith('/c', expect.objectContaining({ websocket }));
  });

  it('sends no websocket key at all when the caller set no bounds', async () => {
    // The transport reads each bound with `??`, so an absent object and an
    // object of undefined values are the same to it today. They must stay the
    // same here too: a key that is always present is a key a later default can
    // silently attach itself to.
    await handler({ collectionPath: '/c' });

    const [, options] = mockedExecute.mock.calls[0] as [string, Record<string, unknown>];
    expect('websocket' in options).toBe(false);
  });
});

describe('the description agrees with the code', () => {
  it('no longer promises that every unparseable file is skipped', () => {
    // The old sentence said so without qualification. run-plan.ts:80-96 throws for
    // a named file and swallows only ENOENT, so the promise held for discovery and
    // broke for exactly the case an agent hits when it names one request.
    expect(description).not.toMatch(/A request file that cannot be parsed is skipped rather than/);
  });

  it('distinguishes a discovered file from one the caller named', () => {
    expect(description).toMatch(/DISCOVERED/);
    expect(description).toMatch(/parseFailures/);
    expect(description).toMatch(/fails the group that named it/);
  });

  it('still describes missing requests as the separate thing they are', () => {
    // Absence and unparseability were already two different outcomes; correcting
    // one must not blur it into the other.
    expect(description).toMatch(/missingRequests/);
  });

  it('names both transports and what their results carry', () => {
    expect(description).toMatch(/grpc and websocket requests all run/);
    expect(description).toMatch(/stop_reason/);
    expect(description).toMatch(/transcript/);
  });

  it('warns that a gRPC code of 0 is not the refusal sentinel', () => {
    // The single most misreadable field in either transport's result: `status: 0`
    // means refused everywhere else in this API, and gRPC's OK is also 0.
    expect(description).toMatch(/0 is OK/);
    expect(description).toMatch(/NOT the refusal sentinel/);
  });
});
