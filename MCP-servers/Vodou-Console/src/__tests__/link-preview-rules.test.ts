import { describe, it, expect } from 'vitest';
import { oembedEndpointFor, previewFromOembed, isGenericPreview } from '../api/link-preview-rules.js';

const THREAD = 'https://www.reddit.com/r/ClaudeCode/comments/1wgjima/where_continuity_breaks_after_compaction_or_an/';

describe('oembedEndpointFor', () => {
  it('routes a Reddit thread to Reddit oEmbed', () => {
    expect(oembedEndpointFor(new URL(THREAD))).toBe('https://www.reddit.com/oembed?url=' + encodeURIComponent(THREAD));
  });
  it('does not route a subreddit (Reddit oEmbed 400s on it) or another site', () => {
    expect(oembedEndpointFor(new URL('https://www.reddit.com/r/ClaudeCode/'))).toBeNull();
    expect(oembedEndpointFor(new URL('https://github.com/anthropics/claude-code'))).toBeNull();
    expect(oembedEndpointFor(new URL('https://notreddit.com/r/x/comments/1/y/'))).toBeNull();
  });
});

describe('previewFromOembed', () => {
  // The fields Reddit actually returned for THREAD on 2026-09-15.
  const REDDIT = { author_name: 'delimitdev', provider_name: 'reddit', provider_url: 'https://www.reddit.com', title: 'Where continuity breaks after compaction or an agent switch', type: 'rich' };

  it('turns a Reddit oEmbed answer into a card that names the thread', () => {
    expect(previewFromOembed(REDDIT, new URL(THREAD))).toEqual({
      domain: 'www.reddit.com',
      title: 'Where continuity breaks after compaction or an agent switch',
      description: 'r/ClaudeCode · u/delimitdev',
      favicon: 'https://www.reddit.com/favicon.ico',
      image: '',
      generic: false,
    });
  });
  it('returns null when there is no title to show', () => {
    expect(previewFromOembed({ ...REDDIT, title: '  ' }, new URL(THREAD))).toBeNull();
    expect(previewFromOembed(null, new URL(THREAD))).toBeNull();
    expect(previewFromOembed('nope', new URL(THREAD))).toBeNull();
  });
});

describe('isGenericPreview', () => {
  it('the stub Reddit answer is generic', () => {
    expect(isGenericPreview({ domain: 'www.reddit.com', title: 'Reddit', description: '', image: '' })).toBe(true);
  });
  it('a title that is just the hostname is generic', () => {
    expect(isGenericPreview({ domain: 'example.com', title: 'example.com' })).toBe(true);
    expect(isGenericPreview({ domain: 'www.example.com', title: 'www.example.com' })).toBe(true);
  });
  it('an empty title is generic', () => {
    expect(isGenericPreview({ domain: 'example.com', title: '' })).toBe(true);
  });
  it('a real page title is not generic', () => {
    expect(isGenericPreview({ domain: 'github.com', title: 'GitHub - anthropics/claude-code', description: '' })).toBe(false);
  });
  it('a site-name title WITH a description or image still says something', () => {
    expect(isGenericPreview({ domain: 'www.reddit.com', title: 'Reddit', description: 'r/ClaudeCode · u/x' })).toBe(false);
    expect(isGenericPreview({ domain: 'www.reddit.com', title: 'Reddit', image: 'https://x/y.png' })).toBe(false);
  });
});
