/**
 * BRU file generator with proper syntax
 * Generates Bruno API testing files in the correct BRU format
 */

import {
  BruFile,
  BruMeta,
  BruHttpRequest,
  BruAuth,
  BruHeaders,
  BruQuery,
  BruBody,
  BruVars,
  BruPreRequestScript,
  BruPostResponseScript,
  BruTests,
  BruGeneratorOptions,
  BruValidationError,
  AuthType,
  BodyType
} from './types.js';

export class BruGenerator {
  private options: Required<BruGeneratorOptions>;

  constructor(options: BruGeneratorOptions = {}) {
    this.options = {
      indentSize: options.indentSize ?? 2,
      useSpaces: options.useSpaces ?? true,
      addTimestamp: options.addTimestamp ?? false,
      validateSyntax: options.validateSyntax ?? true
    };
  }

  /**
   * Generate a complete .bru file from a BruFile object
   */
  generateBruFile(bruFile: BruFile): string {
    if (this.options.validateSyntax) {
      this.validateBruFile(bruFile);
    }

    const sections: string[] = [];

    // Add timestamp comment if requested
    if (this.options.addTimestamp) {
      sections.push(`# Generated on ${new Date().toISOString()}`);
      sections.push('');
    }

    // Generate meta block
    sections.push(this.generateMetaBlock(bruFile.meta));
    sections.push('');

    // Generate HTTP block
    sections.push(this.generateHttpBlock(bruFile.http));
    sections.push('');

    // Generate auth block if present
    if (bruFile.auth && bruFile.auth.type !== 'none') {
      sections.push(this.generateAuthBlock(bruFile.auth));
      sections.push('');
    }

    // Generate headers block if present
    if (bruFile.headers && Object.keys(bruFile.headers).length > 0) {
      sections.push(this.generateHeadersBlock(bruFile.headers));
      sections.push('');
    }

    // Generate query block if present
    if (bruFile.query && Object.keys(bruFile.query).length > 0) {
      sections.push(this.generateQueryBlock(bruFile.query));
      sections.push('');
    }

    // Generate body block if present
    if (bruFile.body && bruFile.body.type !== 'none') {
      sections.push(this.generateBodyBlock(bruFile.body));
      sections.push('');
    }

    // Generate vars block if present
    if (bruFile.vars && Object.keys(bruFile.vars).length > 0) {
      sections.push(this.generateVarsBlock(bruFile.vars));
      sections.push('');
    }

    // Generate script blocks if present
    if (bruFile.script) {
      if (bruFile.script['pre-request']) {
        sections.push(this.generatePreRequestScript(bruFile.script['pre-request']));
        sections.push('');
      }
      if (bruFile.script['post-response']) {
        sections.push(this.generatePostResponseScript(bruFile.script['post-response']));
        sections.push('');
      }
    }

    // Generate tests block if present
    if (bruFile.tests) {
      sections.push(this.generateTestsBlock(bruFile.tests));
      sections.push('');
    }

    // Generate docs if present
    if (bruFile.docs) {
      sections.push('docs {');
      sections.push(this.indent(bruFile.docs));
      sections.push('}');
      sections.push('');
    }

    return sections.join('\n').trim() + '\n';
  }

  /**
   * Generate meta block
   */
  private generateMetaBlock(meta: BruMeta): string {
    const lines = ['meta {'];
    lines.push(this.indent(`name: ${this.escapeString(meta.name)}`));
    lines.push(this.indent(`type: ${meta.type}`));
    if (meta.seq !== undefined) {
      lines.push(this.indent(`seq: ${meta.seq}`));
    }
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate HTTP request block
   */
  private generateHttpBlock(http: BruHttpRequest): string {
    const lines = [`${http.method.toLowerCase()} {`];
    lines.push(this.indent(`url: ${this.escapeString(http.url)}`));
    lines.push(this.indent(`body: ${http.body}`));
    lines.push(this.indent(`auth: ${http.auth}`));
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate auth block
   */
  private generateAuthBlock(auth: BruAuth): string {
    const lines = [`auth:${auth.type} {`];

    switch (auth.type) {
      case 'bearer':
        if (auth.bearer) {
          lines.push(this.indent(`token: ${this.escapeString(auth.bearer.token)}`));
        }
        break;
      case 'basic':
        if (auth.basic) {
          lines.push(this.indent(`username: ${this.escapeString(auth.basic.username)}`));
          lines.push(this.indent(`password: ${this.escapeString(auth.basic.password)}`));
        }
        break;
      case 'oauth2':
        if (auth.oauth2) {
          lines.push(this.indent(`grant_type: ${auth.oauth2.grantType}`));
          if (auth.oauth2.accessTokenUrl) {
            lines.push(this.indent(`access_token_url: ${this.escapeString(auth.oauth2.accessTokenUrl)}`));
          }
          if (auth.oauth2.authorizationUrl) {
            lines.push(this.indent(`authorization_url: ${this.escapeString(auth.oauth2.authorizationUrl)}`));
          }
          if (auth.oauth2.clientId) {
            lines.push(this.indent(`client_id: ${this.escapeString(auth.oauth2.clientId)}`));
          }
          if (auth.oauth2.clientSecret) {
            lines.push(this.indent(`client_secret: ${this.escapeString(auth.oauth2.clientSecret)}`));
          }
          if (auth.oauth2.scope) {
            lines.push(this.indent(`scope: ${this.escapeString(auth.oauth2.scope)}`));
          }
          if (auth.oauth2.username) {
            lines.push(this.indent(`username: ${this.escapeString(auth.oauth2.username)}`));
          }
          if (auth.oauth2.password) {
            lines.push(this.indent(`password: ${this.escapeString(auth.oauth2.password)}`));
          }
        }
        break;
      case 'api-key':
        if (auth.apikey) {
          lines.push(this.indent(`key: ${this.escapeString(auth.apikey.key)}`));
          lines.push(this.indent(`value: ${this.escapeString(auth.apikey.value)}`));
          lines.push(this.indent(`in: ${auth.apikey.in}`));
        }
        break;
      case 'digest':
        if (auth.digest) {
          lines.push(this.indent(`username: ${this.escapeString(auth.digest.username)}`));
          lines.push(this.indent(`password: ${this.escapeString(auth.digest.password)}`));
        }
        break;
    }

    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate headers block
   */
  private generateHeadersBlock(headers: BruHeaders): string {
    const lines = ['headers {'];
    Object.entries(headers).forEach(([key, value]) => {
      lines.push(this.indent(`${key}: ${this.escapeString(value)}`));
    });
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate query parameters block
   */
  private generateQueryBlock(query: BruQuery): string {
    const lines = ['query {'];
    Object.entries(query).forEach(([key, value]) => {
      lines.push(this.indent(`${key}: ${this.formatValue(value)}`));
    });
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate body block
   */
  private generateBodyBlock(body: BruBody): string {
    if (body.type === 'none') {
      return '';
    }

    if (body.type === 'json' || body.type === 'text' || body.type === 'xml') {
      const lines = [`body:${body.type} {`];
      if (body.content) {
        lines.push(this.indent(body.content));
      }
      lines.push('}');
      return lines.join('\n');
    }

    if (body.type === 'form-data' && body.formData) {
      const lines = ['body:multipart-form {'];
      body.formData.forEach(field => {
        if (field.enabled === false) return;
        const values = Array.isArray(field.value) ? field.value : [field.value];
        const suffix = field.contentType ? ` @contentType(${field.contentType})` : '';
        if ((field.type ?? 'text') === 'file') {
          const fileTokens = values.map(v => `@file(${v})`).join(' ');
          lines.push(this.indent(`${field.name}: ${fileTokens}${suffix}`));
        } else {
          values.forEach(v => {
            lines.push(this.indent(`${field.name}: ${this.escapeString(v)}${suffix}`));
          });
        }
      });
      lines.push('}');
      return lines.join('\n');
    }

    if (body.type === 'form-urlencoded' && body.formUrlEncoded) {
      const lines = ['body:form-urlencoded {'];
      body.formUrlEncoded.forEach(field => {
        if (field.enabled !== false) {
          lines.push(this.indent(`${field.name}: ${this.escapeString(field.value)}`));
        }
      });
      lines.push('}');
      return lines.join('\n');
    }

    return '';
  }

  /**
   * Generate variables block
   */
  private generateVarsBlock(vars: BruVars): string {
    const lines = ['vars {'];
    Object.entries(vars).forEach(([key, value]) => {
      lines.push(this.indent(`${key}: ${this.formatValue(value)}`));
    });
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate pre-request script block
   */
  private generatePreRequestScript(script: BruPreRequestScript): string {
    const lines = ['script:pre-request {'];
    script.exec.forEach(line => {
      lines.push(this.indent(line));
    });
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate post-response script block
   */
  private generatePostResponseScript(script: BruPostResponseScript): string {
    const lines = ['script:post-response {'];
    script.exec.forEach(line => {
      lines.push(this.indent(line));
    });
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate tests block
   */
  private generateTestsBlock(tests: BruTests): string {
    const lines = ['tests {'];
    tests.exec.forEach(line => {
      lines.push(this.indent(line));
    });
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Validate BRU file structure
   */
  private validateBruFile(bruFile: BruFile): void {
    if (!bruFile.meta || !bruFile.meta.name) {
      throw new BruValidationError('Meta block with name is required');
    }

    if (!bruFile.http || !bruFile.http.method || !bruFile.http.url) {
      throw new BruValidationError('HTTP block with method and URL is required');
    }

    // Validate URL format (basic check)
    if (!this.isValidUrl(bruFile.http.url)) {
      throw new BruValidationError(`Invalid URL format: ${bruFile.http.url}`);
    }

    // Validate auth configuration if present
    if (bruFile.auth && bruFile.auth.type !== 'none') {
      this.validateAuthConfig(bruFile.auth);
    }
  }

  /**
   * Validate authentication configuration
   */
  private validateAuthConfig(auth: BruAuth): void {
    switch (auth.type) {
      case 'bearer':
        if (!auth.bearer?.token) {
          throw new BruValidationError('Bearer token is required for bearer auth');
        }
        break;
      case 'basic':
        if (!auth.basic?.username || !auth.basic?.password) {
          throw new BruValidationError('Username and password are required for basic auth');
        }
        break;
      case 'api-key':
        if (!auth.apikey?.key || !auth.apikey?.value) {
          throw new BruValidationError('Key and value are required for API key auth');
        }
        break;
    }
  }

  /**
   * Basic URL validation
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      // Check if it's a relative URL or contains variables
      return url.startsWith('/') || url.includes('{{') || url.startsWith('http');
    }
  }

  /**
   * Escape string values for BRU format
   */
  private escapeString(value: string): string {
    // BRU uses single quotes for strings
    if (value.includes("'") || value.includes('\n') || value.includes('\r')) {
      // Use multiline string format for complex strings
      return `'''${value}'''`;
    }
    return `'${value}'`;
  }

  /**
   * Format various value types
   */
  private formatValue(value: string | number | boolean): string {
    if (typeof value === 'string') {
      return this.escapeString(value);
    }
    return String(value);
  }

  /**
   * Add indentation to a line
   */
  private indent(text: string): string {
    const indentChar = this.options.useSpaces ? ' ' : '\t';
    const indentString = this.options.useSpaces ? 
      indentChar.repeat(this.options.indentSize) : 
      indentChar;
    
    return text.split('\n').map(line => 
      line.trim() ? indentString + line : line
    ).join('\n');
  }
}

/**
 * Convenience function to generate a BRU file
 */
export function generateBruFile(bruFile: BruFile, options?: BruGeneratorOptions): string {
  const generator = new BruGenerator(options);
  return generator.generateBruFile(bruFile);
}

/**
 * Create a basic BRU file structure
 */
export function createBasicBruFile(
  name: string,
  method: string,
  url: string,
  sequence?: number
): BruFile {
  return {
    meta: {
      name,
      type: 'http',
      seq: sequence
    },
    http: {
      method: method.toUpperCase() as any,
      url,
      body: 'none',
      auth: 'none'
    }
  };
}