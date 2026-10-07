import { describe, expect, it } from 'vitest';
import { validateJsonTemplate } from '../../../utils/validate-json-template';

describe('validateJsonTemplate', () => {
  describe('accepts valid templates', () => {
    it('a bare component node', () => {
      expect(() =>
        validateJsonTemplate({ type: 'div', children: [] })
      ).not.toThrow();
    });


    it('a full each → card → data tree (the authored list-view shape)', () => {
      expect(() =>
        validateJsonTemplate({
          type: 'div',
          props: { className: 'grid' },
          data_sources: { rows: { query: 'SELECT 1' } },
          children: [
            {
              type: 'each',
              items: 'rows',
              as: 'r',
              render: {
                type: 'card',
                children: [
                  { type: 'data', path: 'r.name' },
                  { type: 'data', path: 'r.amount', format: 'currency', fallback: '—' },
                ],
              },
            },
          ],
        })
      ).not.toThrow();
    });

    it('conditional + string-shorthand each', () => {
      expect(() =>
        validateJsonTemplate({
          type: 'div',
          children: [
            // biome-ignore lint/suspicious/noThenProperty: template DSL conditional branch.
            { type: 'if', condition: 'ok', then: { type: 'text', content: 'yes' } },
            { type: 'each', items: 'xs', as: 'x', render: '- {{x}}' },
          ],
        })
      ).not.toThrow();
    });

    it('every valid format value', () => {
      for (const format of [
        'currency', 'date', 'url', 'enum', 'boolean', 'number', 'auto', 'text',
      ]) {
        expect(() =>
          validateJsonTemplate({ type: 'data', path: 'x', format })
        ).not.toThrow();
      }
    });

    it('an unknown component type (app-registry extension) is permitted', () => {
      // entity-board / entity-table / charts live app-side; the server can't
      // allowlist them, and the renderer degrades gracefully on truly-unknown.
      expect(() =>
        validateJsonTemplate({ type: 'entity-board', props: { state: '{{s}}' } })
      ).not.toThrow();
    });
  });

  describe('rejects malformed templates', () => {
    it('non-object', () => {
      expect(() => validateJsonTemplate('nope')).toThrow(/must be an object/);
    });

    it('a { version, root } wrapper (must store the bare node, not double-wrap)', () => {
      // Consumers re-wrap as { version:1, root: stored }, so storing a wrapper
      // double-nests and renders nothing — reject it at authoring.
      expect(() =>
        validateJsonTemplate({ version: 1, root: { type: 'div' } })
      ).toThrow(/bare root node, not a \{ version, root \} wrapper/);
    });

    it('node without a type', () => {
      expect(() => validateJsonTemplate({ children: [] })).toThrow(/missing a string `type`/);
    });

    it('a data node without a path', () => {
      expect(() => validateJsonTemplate({ type: 'data' })).toThrow(/requires a non-empty string `path`/);
    });

    it('an unknown format value (the silent-render bug this guards)', () => {
      expect(() =>
        validateJsonTemplate({ type: 'data', path: 'x', format: 'moneys' })
      ).toThrow(/unknown format "moneys"/);
    });

    it('an each node missing items/as/render', () => {
      expect(() => validateJsonTemplate({ type: 'each', as: 'x', render: 'r' })).toThrow(/string `items`/);
      expect(() => validateJsonTemplate({ type: 'each', items: 'xs', render: 'r' })).toThrow(/string `as`/);
      expect(() => validateJsonTemplate({ type: 'each', items: 'xs', as: 'x' })).toThrow(/requires a `render`/);
    });

    it('an if node without a condition or then', () => {
      // biome-ignore lint/suspicious/noThenProperty: template DSL conditional branch.
      expect(() => validateJsonTemplate({ type: 'if', then: { type: 'text', content: 'a' } })).toThrow(/string `condition`/);
      expect(() => validateJsonTemplate({ type: 'if', condition: 'c' })).toThrow(/requires a `then`/);
    });

    it('a text node without content', () => {
      expect(() => validateJsonTemplate({ type: 'text' })).toThrow(/requires a string `content`/);
    });

    it('children that is not an array', () => {
      expect(() => validateJsonTemplate({ type: 'div', children: 'x' })).toThrow(/children must be an array/);
    });

    it('a handler prop that does not bind an "@action"', () => {
      expect(() =>
        validateJsonTemplate({ type: 'button', props: { onClick: 'approve' } })
      ).toThrow(/handler props must bind an action as "@actionName"/);
      expect(() =>
        validateJsonTemplate({ type: 'button', props: { onClick: '{{handler}}' } })
      ).toThrow(/handler props must bind an action as "@actionName"/);
      expect(() =>
        validateJsonTemplate({ type: 'button', props: { onChange: 42 } })
      ).toThrow(/handler props must bind an action as "@actionName"/);
      expect(() =>
        validateJsonTemplate({ type: 'button', props: { onClick: '@' } })
      ).toThrow(/handler props must bind an action as "@actionName"/);
      expect(() =>
        validateJsonTemplate({ type: 'button', onClick: 'approve' })
      ).toThrow(/json_template\.onClick/);
    });

    it('accepts a correctly bound handler prop', () => {
      expect(() =>
        validateJsonTemplate({ type: 'button', props: { onClick: '@approve' } })
      ).not.toThrow();
      expect(() =>
        validateJsonTemplate({
          type: 'button',
          onClick: 'shadowed',
          props: { onClick: '@approve' },
        })
      ).not.toThrow();
      // Non-handler props are untouched — only /^on[A-Z]/ keys are constrained.
      expect(() =>
        validateJsonTemplate({ type: 'button', props: { once: 'yes', on: 'x' } })
      ).not.toThrow();
    });

    it('collects portable actions during the same strict validation walk', () => {
      expect(
        validateJsonTemplate({
          type: 'card',
          children: [
            {
              type: 'button',
              onClick: '@shadowed',
              props: { onClick: '@vote' },
            },
            {
              type: 'select',
              props: { onChange: '@choose', options: [] },
            },
            {
              type: 'button',
              props: { onPress: '@press' },
            },
            {
              type: 'button',
              onSubmit: '@submit',
            },
          ],
        })
      ).toEqual(new Set(['vote', 'choose', 'press', 'submit']));
    });

    it('reports the path of a nested handler failure', () => {
      expect(() =>
        validateJsonTemplate({
          type: 'div',
          children: [{ type: 'button', props: { onClick: 'nope' } }],
        })
      ).toThrow(/json_template\.children\[0\]\.props\.onClick/);
    });

    it('reports the path of a nested failure', () => {
      expect(() =>
        validateJsonTemplate({
          type: 'div',
          children: [{ type: 'card', children: [{ type: 'data' }] }],
        })
      ).toThrow(/json_template\.children\[0\]\.children\[0\]/);
    });
  });
});
