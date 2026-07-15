import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { MailboxService } from '../src/services/mailboxService.js';
import type { AccountService } from '../src/services/accountService.js';

/**
 * Generates the "Tools" section of docs/mcp-tools.md directly from the
 * live `tools/list` output — the same descriptions, schemas, and
 * annotations a real MCP client sees — instead of hand-maintaining a
 * second copy that can drift from the code. `npm run docs:mcp` regenerates
 * it; test/mcpDocs.test.ts fails the suite if the committed file is stale.
 */

export const DOCS_PATH = fileURLToPath(new URL('../docs/mcp-tools.md', import.meta.url));

const BEGIN_MARKER = '<!-- BEGIN GENERATED TOOLS: run `npm run docs:mcp` to regenerate -->';
const END_MARKER = '<!-- END GENERATED TOOLS -->';

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
};

const scalarType = (schema: JsonSchema): string => {
  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  return schema.type ?? 'unknown';
};

/** Renders a JSON Schema node as a compact, TypeScript-like shape string,
 * e.g. `{ id: string, watchMailboxes: string[] }`. */
const renderShape = (schema: JsonSchema | undefined): string => {
  if (!schema) return 'unknown';

  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(properties).map(([key, value]) => {
      const optional = !required.has(key);
      return `${key}${optional ? '?' : ''}: ${renderShape(value)}`;
    });
    return fields.length > 0 ? `{ ${fields.join(', ')} }` : '{}';
  }

  if (schema.type === 'array') {
    const itemShape = renderShape(schema.items);
    return itemShape.startsWith('{') ? `${itemShape}[]` : `${itemShape}[]`;
  }

  return scalarType(schema);
};

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const renderInputTable = (inputSchema: JsonSchema): string => {
  const properties = inputSchema.properties ?? {};
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return '**Input:** none.';
  }

  const required = new Set(inputSchema.required ?? []);
  const rows = entries.map(([name, schema]) => {
    const requiredCell = required.has(name)
      ? 'yes'
      : schema.default !== undefined
        ? `no (default: \`${JSON.stringify(schema.default)}\`)`
        : 'no';
    return `| \`${name}\` | ${renderShape(schema)} | ${requiredCell} | ${escapeCell(schema.description ?? '')} |`;
  });

  return [
    '**Input:**',
    '',
    '| Parameter | Type | Required | Description |',
    '| --- | --- | --- | --- |',
    ...rows
  ].join('\n');
};

const ANNOTATION_LABELS: Record<string, string> = {
  readOnlyHint: 'Read-only',
  destructiveHint: 'Destructive',
  idempotentHint: 'Idempotent'
};

type ToolLike = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
};

const renderTool = (tool: ToolLike): string => {
  const annotationKey = Object.keys(tool.annotations ?? {}).find((key) => key in ANNOTATION_LABELS);
  const label = annotationKey ? ANNOTATION_LABELS[annotationKey] : undefined;

  const lines = [`### \`${tool.name}\``, ''];
  if (label) {
    lines.push(`_${label}._ ${tool.description ?? ''}`.trim(), '');
  } else if (tool.description) {
    lines.push(tool.description, '');
  }

  lines.push(renderInputTable(tool.inputSchema), '');
  lines.push(`**Output:** \`${renderShape(tool.outputSchema)}\``);

  return lines.join('\n');
};

const makeStubMailboxService = (): MailboxService => ({
  listMailboxes: async () => [],
  listMessages: async () => [],
  getMessage: async () => false,
  getAttachment: async () => false,
  getRawSource: async () => false,
  moveMessage: async () => false,
  setFlags: async () => undefined
});

const makeStubAccountService = (): AccountService => ({
  listAccounts: async () => []
});

/** Fetches the live tool list (names, descriptions, schemas, annotations)
 * by connecting a real client to a real (stub-backed) server over the
 * SDK's in-memory transport — the same tool metadata a real MCP client
 * would see, with no IMAP/network/config required. */
export const fetchToolList = async (): Promise<ToolLike[]> => {
  const server = createMcpServer({
    mailboxService: makeStubMailboxService(),
    accountService: makeStubAccountService()
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-docs-generator', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();

  return tools as ToolLike[];
};

export const renderToolsSection = (tools: ToolLike[]): string => {
  const body = tools.map(renderTool).join('\n\n');
  return [BEGIN_MARKER, '', body, '', END_MARKER].join('\n');
};

export const buildUpdatedDocs = (currentContent: string, generatedSection: string): string => {
  const beginIndex = currentContent.indexOf(BEGIN_MARKER);
  const endIndex = currentContent.indexOf(END_MARKER);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(
      `Could not find generated-section markers in ${DOCS_PATH}. Expected "${BEGIN_MARKER}" and "${END_MARKER}".`
    );
  }

  return (
    currentContent.slice(0, beginIndex) +
    generatedSection +
    currentContent.slice(endIndex + END_MARKER.length)
  );
};

const main = async (): Promise<void> => {
  const tools = await fetchToolList();
  const generatedSection = renderToolsSection(tools);
  const current = readFileSync(DOCS_PATH, 'utf-8');
  const updated = buildUpdatedDocs(current, generatedSection);
  writeFileSync(DOCS_PATH, updated, 'utf-8');
  process.stderr.write(`Regenerated tool reference in ${DOCS_PATH}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
