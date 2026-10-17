/**
 * Markdown Formatter Tests
 */

import { describe, expect, it } from 'vitest';
import { formatToolResult } from '../markdown-formatter';

describe('formatToolResult', () => {
  describe('search tool', () => {
    it('should format search result with entity', () => {
      const result = {
        entity: {
          id: 1,
          name: 'TestBrand',
          parent_id: null,
          match_reason: 'name_match',
          match_score: 0.95,
          workspace_slug: 'federation-alpha',
          metadata: { domain: 'test.com' },
          stats: {
            content_count: 10,
            connection_count: 2,
            active_connection_count: 1,
            children_count: 3,
          },
        },
        matches: [
          {
            id: 1,
            name: 'TestBrand',
            parent_id: null,
            match_reason: 'name_match',
            match_score: 0.95,
            workspace_slug: 'federation-alpha',
            metadata: { domain: 'test.com' },
            stats: {
              content_count: 10,
              connection_count: 2,
              active_connection_count: 1,
              children_count: 3,
            },
          },
        ],
      };
      const md = formatToolResult('search_memory', result);
      expect(md).toContain('Search Results');
      expect(md).toContain('Entity ID');
      expect(md).toContain('Workspace**: `federation-alpha`');
    });

    it('should format empty search result', () => {
      const result = { entity: null, matches: [] };
      const md = formatToolResult('search_memory', result);
      expect(md).toContain('No Results Found');
    });

    it('should render channel-conversation hits instead of "No Results"', () => {
      const result = {
        entity: null,
        matches: [],
        conversation_messages: [
          {
            platform: 'slack',
            channel_id: 'C-RECAP',
            thread_id: null,
            author_name: 'Alice',
            text: 'We reviewed the quarterly revenue forecast',
            occurred_at: '2026-06-26T10:00:00.000Z',
            workspace_slug: 'federation-alpha',
          },
        ],
      };
      const md = formatToolResult('search_memory', result);
      expect(md).not.toContain('No Results Found');
      expect(md).toContain('Channel Conversation');
      expect(md).toContain('quarterly revenue forecast');
      expect(md).toContain('Alice');
      expect(md).toContain('workspace `federation-alpha`');
    });

    it('renders stable event ids for related content follow-ups', () => {
      const result = {
        entity: null,
        matches: [],
        content: [
          {
            id: 66,
            title: 'A collected item',
            platform: 'hackernews',
            text_content: 'Collected text',
            workspace_slug: 'federation-alpha',
            workspace_slugs: ['federation-alpha', 'federation-beta'],
          },
        ],
      };

      const md = formatToolResult('search_memory', result);
      expect(md).toContain('Lobu event ID**: 66');
      expect(md).toContain('Visible through workspaces');
      expect(md).toContain('`federation-alpha`, `federation-beta`');
    });

    it('says when recall ranked on text only', () => {
      const md = formatToolResult('search_memory', {
        entity: null,
        matches: [],
        coverage: {
          local_sources: ['events'],
          source_queried: false,
          source_feed_discovery: 'complete',
          scope: 'current_workspace',
          status: 'partial',
          reason: 'query_embedding_unavailable',
          source_feeds: [],
          more_source_feeds: false,
        },
      });
      expect(md).toContain('Ranking was text-only');
    });

    it('renders the local/source boundary and explicit feed IDs', () => {
      const result = {
        entity: null,
        matches: [],
        coverage: {
          local_sources: ['events', 'channel_messages'],
          source_queried: false,
          source_feed_discovery: 'complete',
          scope: 'all_granted',
          status: 'partial',
          workspaces: [
            { workspace_slug: 'federation-alpha', status: 'complete' },
            { workspace_slug: 'federation-beta', status: 'unavailable' },
          ],
          source_feeds: [
            {
              feed_id: 42,
              feed_key: 'messages',
              connection_slug: 'whatsapp-personal',
              connector_key: 'whatsapp.web',
              display_name: 'WhatsApp messages',
              status: 'not_queried',
              workspace_slug: 'federation-alpha',
            },
          ],
          more_source_feeds: false,
        },
      };

      const md = formatToolResult('search_memory', result);
      expect(md).toContain('Search Coverage');
      expect(md).toContain('Scope: all_granted. Status: partial.');
      expect(md).toContain('`federation-beta`: unavailable');
      expect(md).toContain('Local stores searched: events, channel_messages');
      expect(md).toContain('Connected source feeds were not queried');
      expect(md).toContain('Feed 42: `whatsapp-personal/messages`');
      expect(md).toContain('client.feeds.readMany');
    });

  });

  describe('query_sql tool', () => {
    it('should format SQL results as CSV', () => {
      const result = {
        rows: [
          { id: 1, name: 'Brand A' },
          { id: 2, name: 'Brand B' },
        ],
        columns: [
          { name: 'id', type: 'int4' },
          { name: 'name', type: 'text' },
        ],
        total_count: 5,
        has_more: true,
        execution_time_ms: 15,
      };
      const md = formatToolResult('query_sql', result);
      expect(md).toContain('SQL Query Results');
      expect(md).toContain('**Rows**: 5');
      expect(md).not.toContain('Rows**: undefined');
      expect(md).toContain('Brand A');
      expect(md).toContain('Brand B');
      expect(md).toContain('csv');
    });

    it('should handle empty SQL result', () => {
      const result = {
        rows: [],
        columns: [],
        total_count: 0,
        has_more: false,
        execution_time_ms: 5,
      };
      const md = formatToolResult('query_sql', result);
      expect(md).toContain('**Rows**: 0');
    });
  });

  describe('save_memory tool', () => {
    it('keeps render payload out of the compact text fallback', () => {
      const md = formatToolResult('save_memory', {
        id: 42,
        title: 'Saved chart',
        semantic_type: 'observation',
        payload_type: 'json_template',
        payload_text: 'large-payload-marker'.repeat(10_000),
        payload_data: { privateMarker: 'structured-content-only' },
        payload_template: { root: { type: 'text', content: '{{privateMarker}}' } },
        attachments: [{ name: 'large.json' }],
        source_url: 'https://example.com/source',
        created: true,
        view_url: 'https://example.com/memory?content_ids=42',
      });

      expect(md).toContain('"id": 42');
      expect(md).toContain('"title": "Saved chart"');
      expect(md).toContain('"created": true');
      expect(md).toContain('"view_url"');
      expect(md).not.toContain('large-payload-marker');
      expect(md).not.toContain('structured-content-only');
      expect(md).not.toContain('payload_template');
      expect(md.length).toBeLessThan(1_000);
    });
  });

  describe('get_automation tool', () => {
    it('should format Automation windows', () => {
      const result = {
        windows: [
          {
            automation_name: 'Sentiment',
            window_start: '2025-01-01T00:00:00Z',
            window_end: '2025-01-07T00:00:00Z',
            content_analyzed: 50,
            model_used: 'test-model',
            execution_time_ms: 100,
            extracted_data: { summary: 'Mostly positive' },
          },
        ],
      };
      const md = formatToolResult('get_automation', result);
      expect(md).toContain('Automation Windows');
      expect(md).toContain('Sentiment');
      // Arrival windows have no period shape, so the render names the BOUNDS.
      expect(md).not.toContain('Granularity');
      expect(md).toContain('Content Analyzed');
    });

    it('should format no Automation windows available', () => {
      const result = { windows: [] };
      const md = formatToolResult('get_automation', result);
      expect(md).toContain('No Automation Windows Available');
    });
  });

  describe('manage_automations tool', () => {
    it('should format create result', () => {
      const result = {
        action: 'create',
        automation_id: 42,
        template_version: 1,
        status: 'active',
      };
      const md = formatToolResult('manage_automations', result);
      expect(md).toContain('Automation Management');
      expect(md).toContain('42');
    });

    it('should format list result', () => {
      const result = {
        action: 'list',
        automations: [
          {
            automation_id: 1,
            template_slug: 'sentiment',
            status: 'active',
            entity_name: 'Acme',
            entity_type: 'topic',
            template_version: 1,
          },
        ],
      };
      const md = formatToolResult('manage_automations', result);
      expect(md).toContain('Automations (1)');
    });

    it('should format template list result', () => {
      const result = {
        action: 'list',
        templates: [
          {
            template_id: '25',
            slug: 'reddit-opportunity-finder',
            name: 'Reddit Opportunity Finder',
            current_version: 1,
            automations_count: 0,
          },
        ],
      };
      const md = formatToolResult('manage_automations', result);
      expect(md).toContain('Templates (1)');
      expect(md).toContain('reddit-opportunity-finder');
    });

    it('should format template create result', () => {
      const result = {
        action: 'create',
        template_id: '25',
        slug: 'reddit-opportunity-finder',
        version: 1,
      };
      const md = formatToolResult('manage_automations', result);
      expect(md).toContain('New Template Created');
      expect(md).toContain('reddit-opportunity-finder');
    });
  });

  describe('read_knowledge tool', () => {
    it('should format content result', () => {
      const result = {
        content: [
          {
            id: 1,
            platform: 'reddit',
            author_name: 'user1',
            title: 'Great insights',
            text_content: 'Really love it',
            occurred_at: '2025-01-01T00:00:00Z',
            score: 75.5,
          },
        ],
        total: 1,
        page: { offset: 0, limit: 50, has_more: false },
      };
      const md = formatToolResult('read_knowledge', result);
      expect(md).toContain('Content');
    });

    it('should format empty content', () => {
      const result = {
        content: [],
        total: 0,
        page: { offset: 0, limit: 50, has_more: false },
      };
      const md = formatToolResult('read_knowledge', result);
      expect(md).toContain('0 total');
    });

    it('keeps structured Automation context visible when window content is empty', () => {
      const result = {
        content: [],
        total: 0,
        page: { offset: 0, limit: 50, has_more: false },
        window_token: 'window-token',
        window_start: '2026-07-15T00:00:00.000Z',
        window_end: '2026-07-16T00:00:00.000Z',
        entities: [
          {
            id: 7,
            name: 'Acme',
            type: 'company',
            metadata: { stage: 'seed' },
            field_controls: { stage: { note: 'confirmed by user' } },
          },
        ],
        sources: {
          task_list: [{ id: 11, action: 'Send the report', status: 'backlog' }],
          empty_source: [],
        },
        reactions_guidance: 'Notify only for actionable changes.',
        past_reactions: '## Past Reactions\n- Recent reaction: sent one notification.',
        past_feedback:
          '## Past Corrections from User Feedback\n- Recent feedback: avoid duplicate alerts.',
      };

      const md = formatToolResult('read_knowledge', result);
      expect(md).toContain('Bound Entities (1)');
      expect(md).toContain('Acme');
      expect(md).toContain('Named Sources');
      expect(md).toContain('task_list (1)');
      expect(md).toContain('Send the report');
      expect(md).toContain('empty_source (0)');
      expect(md).toContain('Notify only for actionable changes.');
      expect(md).toContain('Recent reaction: sent one notification.');
      expect(md).toContain('Recent feedback: avoid duplicate alerts.');
      expect(md.match(/^#{2,3} Past Reactions$/gm)).toHaveLength(1);
      expect(md.match(/^#{2,3} Past (?:Feedback|Corrections from User Feedback)$/gm)).toHaveLength(
        1
      );
    });
  });

  describe('unknown tool', () => {
    it('should fallback to JSON for unknown tools', () => {
      const result = { foo: 'bar' };
      const md = formatToolResult('unknown_tool', result);
      expect(md).toContain('json');
      expect(md).toContain('"foo"');
    });
  });

  describe('options', () => {
    it('should include raw JSON when requested', () => {
      const result = { rows: [], row_count: 0, execution_time_ms: 5 };
      const md = formatToolResult('query_sql', result, {
        includeRawJson: true,
      });
      expect(md).toContain('Raw JSON');
    });
  });
});
