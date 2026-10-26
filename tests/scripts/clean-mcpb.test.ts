/**
 * @fileoverview Bundle filtering preserves dependency runtime modules.
 * @module tests/scripts/clean-mcpb.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation', () => {
  const docs = [
    'node_modules/example/skills/guide/SKILL.md',
    'node_modules/@scope/example/framework-skills/guide/SKILL.md',
    'node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/skills/guide/SKILL.md',
    'node_modules/example/SKILL.md',
    'node_modules/outer/node_modules/@scope/inner/skills/guide/SKILL.md',
  ];

  it('removes documentation shipped at dependency package roots', () => {
    expect(filterAgentDocEntries(docs)).toEqual(docs);
    expect(checkBundleEntries(docs, 'fixture.mcpb')).toHaveLength(1);
  });

  it('preserves runtime skills modules and the server caller skill', () => {
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
      'node_modules/outer/node_modules/@scope/inner/dist/skills/index.js',
      'node_modules/example/dist/framework-skills/index.js',
      'skills/inaturalist-guide/SKILL.md',
    ];
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(checkBundleEntries(runtime, 'fixture.mcpb')).toEqual([]);
  });
});
