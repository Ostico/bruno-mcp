import { promises as fs } from 'fs';
import { WorkspaceResolver } from './workspace.js';
import { CollectionInfo } from './types.js';

export interface ListCollectionsArgs {
  workspacePath?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listCollectionsHandler(
  resolver: WorkspaceResolver,
  args: ListCollectionsArgs,
): Promise<CollectionInfo[]> {
  const collections = await resolver.resolve(args.workspacePath);

  const results: CollectionInfo[] = await Promise.all(
    collections.map(async (c) => ({
      name: c.name,
      path: c.path,
      exists: await pathExists(c.path),
    })),
  );

  return results;
}
