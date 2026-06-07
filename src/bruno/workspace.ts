import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { WorkspaceCollection, WorkspaceYml } from './types.js';

function defaultWorkspacePath(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'bruno', 'default-workspace', 'workspace.yml');
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'bruno', 'default-workspace', 'workspace.yml');
    default:
      return join(home, '.config', 'bruno', 'default-workspace', 'workspace.yml');
  }
}

export class WorkspaceResolver {
  async resolve(explicitPath?: string): Promise<WorkspaceCollection[]> {
    const workspacePath = this.resolveWorkspacePath(explicitPath);

    let content: string;
    try {
      content = await fs.readFile(workspacePath, 'utf-8');
    } catch {
      return [];
    }

    return this.parseWorkspaceYaml(content);
  }

  resolveWorkspacePath(explicitPath?: string): string {
    if (explicitPath) {
      return explicitPath;
    }

    const envPath = process.env.BRUNO_WORKSPACE_PATH;
    if (envPath) {
      return envPath;
    }

    return defaultWorkspacePath();
  }

  getDefaultPath(): string {
    return defaultWorkspacePath();
  }

  parseWorkspaceYaml(content: string): WorkspaceCollection[] {
    const data = parseYaml(content) as WorkspaceYml | null;
    if (!data || !Array.isArray(data.collections)) {
      return [];
    }

    return data.collections
      .filter((c: unknown): c is { name: string; path: string } =>
        typeof c === 'object' && c !== null && typeof (c as any).name === 'string' && typeof (c as any).path === 'string'
      )
      .map((c: { name: string; path: string }) => ({
        name: c.name,
        path: c.path,
      }));
  }
}

export function createWorkspaceResolver(): WorkspaceResolver {
  return new WorkspaceResolver();
}
