/**
 * The syscall-level contract of writeFileAtomic (finding S24).
 *
 * The real-filesystem suite proves the observable behaviour. These assert the
 * properties that make it *safe* and that no black-box test can see: where the
 * temporary file is placed, that it cannot be hijacked, that it is never
 * world-readable, and that the durability steps happen in the right order.
 */

jest.mock('node:fs/promises', () => ({
  open: jest.fn(),
  rename: jest.fn(),
  stat: jest.fn(),
  unlink: jest.fn(),
}));

import { constants as fsConstants } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from '../../../src/bruno/atomic-write';

const mockOpen = open as unknown as jest.Mock;
const mockRename = rename as unknown as jest.Mock;
const mockStat = stat as unknown as jest.Mock;
const mockUnlink = unlink as unknown as jest.Mock;

const TARGET = path.join(path.sep, 'collections', 'orders', 'request.bru');

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

/** A FileHandle stub that records the order of the calls made on it. */
function handleStub(calls: string[]) {
  return {
    writeFile: jest.fn(async () => {
      calls.push('writeFile');
    }),
    sync: jest.fn(async () => {
      calls.push('sync');
    }),
    chmod: jest.fn(async () => {
      calls.push('chmod');
    }),
    close: jest.fn(async () => {
      calls.push('close');
    }),
  };
}

describe('writeFileAtomic — temp file contract', () => {
  let calls: string[];
  let handle: ReturnType<typeof handleStub>;

  beforeEach(() => {
    jest.clearAllMocks();
    calls = [];
    handle = handleStub(calls);
    mockOpen.mockResolvedValue(handle);
    mockRename.mockImplementation(async () => {
      calls.push('rename');
    });
    mockStat.mockRejectedValue(enoent());
    mockUnlink.mockResolvedValue(undefined);
  });

  it('places the temporary file in the target directory, not the system temp dir', async () => {
    await writeFileAtomic(TARGET, 'content');

    const tempPath = mockOpen.mock.calls[0][0] as string;
    // Same directory keeps the rename on one filesystem (no EXDEV) and keeps the
    // content out of a world-readable shared /tmp.
    expect(path.dirname(tempPath)).toBe(path.dirname(TARGET));
    expect(tempPath.startsWith(tmpdir())).toBe(false);
  });

  it('uses an unpredictable temp name so it cannot be pre-planted', async () => {
    await writeFileAtomic(TARGET, 'content');
    await writeFileAtomic(TARGET, 'content');

    const [first, second] = mockOpen.mock.calls.map((c) => c[0] as string);
    expect(first).not.toBe(second);
    expect(path.basename(first)).toMatch(/^\.request\.bru\.[0-9a-f]{16}\.tmp$/);
  });

  it('creates the temp file exclusively, so a symlink at that path is not followed', async () => {
    await writeFileAtomic(TARGET, 'content');

    const flags = mockOpen.mock.calls[0][1] as number;
    expect(flags & fsConstants.O_EXCL).toBe(fsConstants.O_EXCL);
    expect(flags & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
  });

  it('creates the temp file unreadable to other users', async () => {
    await writeFileAtomic(TARGET, 'secret');

    expect(mockOpen.mock.calls[0][2]).toBe(0o600);
  });

  it('flushes to disk before the rename, and only chmods once the data is safe', async () => {
    await writeFileAtomic(TARGET, 'content');

    expect(calls).toEqual(['writeFile', 'sync', 'chmod', 'close', 'rename']);
  });

  it('gives a brand-new file 0o644', async () => {
    await writeFileAtomic(TARGET, 'content');

    expect(handle.chmod).toHaveBeenCalledWith(0o644);
  });

  it('carries an existing file’s permissions over to the replacement', async () => {
    mockStat.mockResolvedValue({ mode: 0o100600 });

    await writeFileAtomic(TARGET, 'content');

    expect(handle.chmod).toHaveBeenCalledWith(0o600);
  });

  it('does not touch the target when its mode cannot be read', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    await expect(writeFileAtomic(TARGET, 'content')).rejects.toThrow('EACCES');

    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('closes and removes the temp file when writing fails, and reports the real error', async () => {
    handle.writeFile.mockRejectedValue(new Error('ENOSPC'));

    await expect(writeFileAtomic(TARGET, 'content')).rejects.toThrow('ENOSPC');

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalledWith(mockOpen.mock.calls[0][0]);
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('removes the temp file when the rename fails', async () => {
    mockRename.mockRejectedValue(new Error('EXDEV'));

    await expect(writeFileAtomic(TARGET, 'content')).rejects.toThrow('EXDEV');

    expect(mockUnlink).toHaveBeenCalledWith(mockOpen.mock.calls[0][0]);
  });

  it('lets the original failure surface even if cleanup also fails', async () => {
    handle.writeFile.mockRejectedValue(new Error('ENOSPC'));
    handle.close.mockRejectedValue(new Error('EBADF'));
    mockUnlink.mockRejectedValue(new Error('EPERM'));

    await expect(writeFileAtomic(TARGET, 'content')).rejects.toThrow('ENOSPC');
  });
});
