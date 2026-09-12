import { describe, expect, it } from 'vitest';
import { REUSABLE_SLIDE_TYPES } from './library/slide-library.models';
import { REUSABLE_SLIDE_FIXTURES } from './library/slide-library.fixtures';
import { parseAdaptiveConversation } from './library/components/adaptive-conversation/adaptive-conversation.definition';
import { createDefaultSlideContentRegistry, SlideContentRegistry } from './slide-content-registry';

describe('slide content registry', () => {
  it('ships the shared renderers currently owned by the slide exercise foundation', () => {
    const registry = createDefaultSlideContentRegistry();

    expect(registry.resolve('message')).toBeDefined();
    expect(registry.resolve('summary')?.chromeDefaults).toEqual({ header: { visible: false } });
    expect(registry.resolve('choice')?.chromeDefaults).toEqual({
      footer: {
        primary: { id: 'check', label: 'Check', behavior: 'content', disabled: true },
      },
    });
    expect(REUSABLE_SLIDE_TYPES.every((type) => registry.resolve(type))).toBe(true);
    expect(registry.registeredTypes()).toHaveLength(REUSABLE_SLIDE_TYPES.length + 2);
  });

  it('rejects duplicate renderer ownership for the same slide type', () => {
    const registry = new SlideContentRegistry();
    const renderer = {
      type: 'custom',
      loadComponent: async () => { throw new Error('not loaded in this test'); },
    };
    registry.register(renderer);

    expect(() => registry.register(renderer)).toThrow('Slide content renderer already registered: custom');
  });

  it('registers conversation practice without a scored or client-completable default action', () => {
    const registry = createDefaultSlideContentRegistry();
    expect(registry.resolve('adaptive-conversation')?.chromeDefaults).toEqual({ footer: { primary: false } });
    expect(REUSABLE_SLIDE_TYPES).toContain('adaptive-conversation');
    const slide = REUSABLE_SLIDE_FIXTURES.find((candidate) => candidate.type === 'adaptive-conversation');
    expect(slide?.id).toBe('showcase-adaptive-conversation');
    expect(parseAdaptiveConversation(slide?.data)).toMatchObject({
      mode: 'guided-dialogue', minimumTurns: 2, maximumTurns: 3,
    });
    expect(slide?.id).toBe('showcase-adaptive-conversation');
  });
});
