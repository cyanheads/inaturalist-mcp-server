# inaturalist-mcp-server - Directory Structure

Generated on: 2026-09-20 02:46:09

```text
inaturalist-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── inaturalist-observation.resource.ts
│   │   │       └── inaturalist-taxon.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── inaturalist-find-places.tool.ts
│   │       │   ├── inaturalist-get-histogram.tool.ts
│   │       │   ├── inaturalist-get-leaderboard.tool.ts
│   │       │   ├── inaturalist-get-observation.tool.ts
│   │       │   ├── inaturalist-get-similar-species.tool.ts
│   │       │   ├── inaturalist-get-species-counts.tool.ts
│   │       │   ├── inaturalist-get-taxon.tool.ts
│   │       │   ├── inaturalist-list-reference.tool.ts
│   │       │   ├── inaturalist-resolve-name.tool.ts
│   │       │   └── inaturalist-search-observations.tool.ts
│   │       ├── observation-filters.ts
│   │       ├── observation-record.ts
│   │       └── taxon-document.ts
│   ├── services/
│   │   └── inaturalist/
│   │       ├── inaturalist-service.ts
│   │       ├── projections.ts
│   │       ├── types.ts
│   │       └── vocabularies.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── helpers/
│   │   ├── fake-inaturalist-service.ts
│   │   └── fixtures.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── inaturalist-observation.resource.test.ts
│   │   │       └── inaturalist-taxon.resource.test.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── inaturalist-find-places.tool.test.ts
│   │       │   ├── inaturalist-get-histogram.tool.test.ts
│   │       │   ├── inaturalist-get-leaderboard.tool.test.ts
│   │       │   ├── inaturalist-get-observation.tool.test.ts
│   │       │   ├── inaturalist-get-similar-species.tool.test.ts
│   │       │   ├── inaturalist-get-species-counts.tool.test.ts
│   │       │   ├── inaturalist-get-taxon.tool.test.ts
│   │       │   ├── inaturalist-list-reference.tool.test.ts
│   │       │   ├── inaturalist-resolve-name.tool.test.ts
│   │       │   └── inaturalist-search-observations.tool.test.ts
│   │       ├── observation-filters.test.ts
│   │       ├── observation-record.test.ts
│   │       └── taxon-document.test.ts
│   ├── services/
│   │   └── inaturalist/
│   │       ├── inaturalist-service-aggregates.test.ts
│   │       ├── inaturalist-service.test.ts
│   │       ├── projections-taxon.test.ts
│   │       ├── projections.test.ts
│   │       └── vocabularies.test.ts
│   └── smoke/
│       └── definitions.smoke.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
