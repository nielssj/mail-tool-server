import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { DOCS_PATH, fetchToolList, renderToolsSection, buildUpdatedDocs } from '../scripts/mcpDocs.js';

describe('docs/mcp-tools.md generated tool reference', () => {
  it('matches what regenerating it now would produce', async () => {
    const current = readFileSync(DOCS_PATH, 'utf-8');
    const tools = await fetchToolList();
    const generatedSection = renderToolsSection(tools);
    const expected = buildUpdatedDocs(current, generatedSection);

    expect(
      current,
      'docs/mcp-tools.md is stale — a tool\'s description, schema, or annotations ' +
        'changed since it was last generated. Run `npm run docs:mcp` and commit the result.'
    ).toBe(expected);
  });
});
