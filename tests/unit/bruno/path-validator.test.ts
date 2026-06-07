import { validatePath, validateCollectionPath } from '../../../src/bruno/path-validator.js';
import path from 'path';

describe('validatePath', () => {
  // --- Valid paths ---

  it('should accept a path within the allowed base', () => {
    const result = validatePath('/workspace/MateCat/Context-Url', '/workspace');
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(path.resolve('/workspace/MateCat/Context-Url'));
  });

  it('should accept the base directory itself', () => {
    const result = validatePath('/workspace', '/workspace');
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(path.resolve('/workspace'));
  });

  it('should accept a deeply nested path within base', () => {
    const result = validatePath('/workspace/col/sub/deep/file.yml', '/workspace');
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(path.resolve('/workspace/col/sub/deep/file.yml'));
  });

  it('should resolve relative segments that stay within base', () => {
    // /workspace/col/../col2 resolves to /workspace/col2 which is still within /workspace
    const result = validatePath('/workspace/col/../col2', '/workspace');
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe(path.resolve('/workspace/col2'));
  });

  // --- Traversal attacks ---

  it('should reject path traversal with ../../etc/passwd', () => {
    const result = validatePath('/workspace/MateCat/../../etc/passwd', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason!.toLowerCase()).toMatch(/outside|traversal|beyond/);
  });

  it('should reject simple ../ traversal beyond base', () => {
    const result = validatePath('/workspace/../secret', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should reject deeply nested traversal that escapes', () => {
    const result = validatePath('/workspace/a/b/c/../../../../etc/shadow', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should reject a completely unrelated path', () => {
    const result = validatePath('/etc/passwd', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should reject path that is a prefix but not a proper child', () => {
    // /workspace-evil is NOT within /workspace even though it starts with /workspace
    const result = validatePath('/workspace-evil/file', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  // --- Null bytes ---

  it('should reject path containing null bytes', () => {
    const result = validatePath('/workspace/MateCat\x00.yml', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason!.toLowerCase()).toMatch(/null/);
  });

  it('should reject path with null byte at the end', () => {
    const result = validatePath('/workspace/file.txt\x00', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should reject path with null byte in the middle', () => {
    const result = validatePath('/workspace/fi\x00le.txt', '/workspace');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  // --- Base path normalization ---

  it('should normalize the base path before comparison', () => {
    // Base with trailing slash should still work
    const result = validatePath('/workspace/col/file.yml', '/workspace/');
    expect(result.valid).toBe(true);
  });

  it('should reject null bytes in the base path', () => {
    const result = validatePath('/workspace/file.txt', '/work\x00space');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  // --- Empty / edge cases ---

  it('should handle empty input path by resolving to cwd', () => {
    // path.resolve('') returns cwd, which is outside /workspace
    const result = validatePath('', '/workspace');
    expect(result.valid).toBe(false);
  });

  it('should handle relative input path by resolving against cwd', () => {
    // A bare relative path gets resolved against cwd which is outside /workspace
    const result = validatePath('relative/path', '/workspace');
    expect(result.valid).toBe(false);
  });
});

describe('validateCollectionPath', () => {
  const workspaceCollections = [
    { path: '/Users/test/bruno/MateCat' },
    { path: '/Users/test/bruno/MyMemory' },
    { path: '/Users/test/bruno/ESTest' },
  ];

  // --- Valid collection paths ---

  it('should accept an exact collection path', () => {
    const result = validateCollectionPath('/Users/test/bruno/MateCat', workspaceCollections);
    expect(result.valid).toBe(true);
  });

  it('should accept a path within a known collection', () => {
    const result = validateCollectionPath(
      '/Users/test/bruno/MateCat/Context-Url/Schema.yml',
      workspaceCollections,
    );
    expect(result.valid).toBe(true);
  });

  it('should accept a deeply nested path within a collection', () => {
    const result = validateCollectionPath(
      '/Users/test/bruno/MyMemory/sub/deep/req.yml',
      workspaceCollections,
    );
    expect(result.valid).toBe(true);
  });

  // --- Invalid paths ---

  it('should reject a path not in any collection', () => {
    const result = validateCollectionPath('/etc/passwd', workspaceCollections);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should reject a path that is a sibling of a collection', () => {
    const result = validateCollectionPath('/Users/test/bruno/Unknown', workspaceCollections);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should reject a path that traverses out of a collection', () => {
    const result = validateCollectionPath(
      '/Users/test/bruno/MateCat/../../etc/passwd',
      workspaceCollections,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should reject a path that is a prefix but not a proper child', () => {
    // /Users/test/bruno/MateCat-evil is NOT within /Users/test/bruno/MateCat
    const result = validateCollectionPath(
      '/Users/test/bruno/MateCat-evil/file.yml',
      workspaceCollections,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  // --- Null bytes ---

  it('should reject a path with null bytes', () => {
    const result = validateCollectionPath(
      '/Users/test/bruno/MateCat\x00/file.yml',
      workspaceCollections,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  // --- Empty collections ---

  it('should reject any path when workspace has no collections', () => {
    const result = validateCollectionPath('/some/path', []);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  // --- Parent of collection ---

  it('should reject the parent directory of a collection', () => {
    const result = validateCollectionPath('/Users/test/bruno', workspaceCollections);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
