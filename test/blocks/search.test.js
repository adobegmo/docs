import { expect } from '@esm-bundle/chai';
import {
  getSnippet,
  highlight,
  normalizeEntry,
  search,
  slugify,
  tokenize,
} from '../../blocks/header/search.js';

const entries = [
  {
    path: '/paid-social',
    title: 'Paid social',
    description: 'Paid social ads reach audiences on their social media feeds.',
    headings: '["Ad formats","Video specs"]',
    content: 'Intro to paid social. Video ads are distilled from longer content.',
  },
  {
    path: '/brand-book',
    title: 'Brand Book',
    description: 'Our brand identifiers and typography.',
    headings: '["Typography","Color"]',
    content: 'The voice and tone expressed in what we write, including social posts.',
  },
].map(normalizeEntry);

describe('search', () => {
  it('normalizes JSON-encoded array properties', () => {
    expect(entries[0].headings).to.deep.equal(['Ad formats', 'Video specs']);
    expect(normalizeEntry({ path: '/x', content: '["a  b","c"]' }).content).to.equal('a b c');
  });

  it('tokenizes and dedupes terms', () => {
    expect(tokenize('  Social  social ads ')).to.deep.equal(['social', 'ads']);
  });

  it('ranks title matches above body matches', () => {
    const results = search('social', entries);
    expect(results.map((r) => r.entry.path)).to.deep.equal(['/paid-social', '/brand-book']);
  });

  it('requires every term to match', () => {
    expect(search('social typography', entries).map((r) => r.entry.path)).to.deep.equal(['/brand-book']);
    expect(search('nonexistent', entries)).to.have.length(0);
  });

  it('deep-links to the best matching heading', () => {
    const [result] = search('video specs', entries);
    expect(result.heading).to.equal('Video specs');
    expect(slugify(result.heading)).to.equal('video-specs');
  });

  it('slugifies like AEM heading ids', () => {
    expect(slugify('Intro to paid social!')).to.equal('intro-to-paid-social');
  });

  it('builds a snippet around the first match', () => {
    expect(getSnippet(entries[1], ['social'])).to.contain('social posts');
  });

  it('highlights terms without interpreting HTML', () => {
    const div = document.createElement('div');
    div.append(highlight('<img src=x> social', ['social']));
    expect(div.querySelector('img')).to.equal(null);
    expect(div.querySelector('mark').textContent).to.equal('social');
  });
});
