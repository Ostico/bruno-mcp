import { createBrunoMcpServer } from '../../src/server';

/**
 * stop() exists for the uncaughtException guard, which calls it without
 * awaiting while the process is already failing. It therefore has to be safe
 * to call on a server that was never started, and it must not throw on its own.
 */
describe('BrunoMcpServer.stop', () => {
  it('should close the underlying MCP server', async () => {
    const server = createBrunoMcpServer();
    const inner = (server as unknown as { server: { close: () => Promise<void> } })
      .server;
    const close = jest.spyOn(inner, 'close').mockResolvedValue(undefined);

    await expect(server.stop()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);

    close.mockRestore();
  });

  it('should resolve when the server was never started', async () => {
    // The real path, unmocked: no transport is connected, so there is nothing
    // to close and this must still settle rather than reject.
    const server = createBrunoMcpServer();

    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('should be safe to call twice', async () => {
    const server = createBrunoMcpServer();

    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
