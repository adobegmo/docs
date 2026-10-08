import { getConfig } from '../../scripts/ak.js';

/*
 * Site search dialog, lazy-loaded by header.js on first use. Searches the
 * `search` index (helix-query.yaml -> /search-index.json) entirely client-side,
 * falling back to /query-index.json (title/description only) if it is missing.
 */

const MAX_RESULTS = 20;
const SNIPPET_LENGTH = 160;
const WEIGHTS = { title: 10, heading: 5, description: 3, content: 1 };

let indexPromise;
let dialog;

// Array-valued index properties are delivered as JSON-encoded strings.
const toList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  return [value];
};

export const toText = (value) => toList(value).join(' ').replace(/\s+/g, ' ').trim();

export const slugify = (text) => text
  .toLowerCase()
  .trim()
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s+/g, '-');

export function normalizeEntry(row) {
  return {
    path: row.path,
    title: row.title || row.path,
    description: row.description || '',
    headings: toList(row.headings).map((h) => h.trim()).filter(Boolean),
    content: toText(row.content),
  };
}

export const tokenize = (query) => [...new Set(
  query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean),
)];

const wordStartBonus = (text, term) => {
  const idx = text.indexOf(term);
  if (idx < 0) return 0;
  return idx === 0 || /\W/.test(text[idx - 1]) ? 1.5 : 1;
};

/**
 * Scores entries against a query. Every term must match somewhere on the page.
 * @returns {Array<{entry, score, heading}>} sorted best-first
 */
export function search(query, entries) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const phrase = terms.join(' ');

  return entries.reduce((acc, entry) => {
    const title = entry.title.toLowerCase();
    const description = entry.description.toLowerCase();
    const content = entry.content.toLowerCase();
    const headings = entry.headings.map((h) => h.toLowerCase());

    let score = 0;
    const allMatch = terms.every((term) => {
      const t = wordStartBonus(title, term) * WEIGHTS.title;
      const h = Math.max(0, ...headings.map((hd) => wordStartBonus(hd, term))) * WEIGHTS.heading;
      const d = wordStartBonus(description, term) * WEIGHTS.description;
      const c = wordStartBonus(content, term) * WEIGHTS.content;
      score += t + h + d + c;
      return t || h || d || c;
    });
    if (!allMatch) return acc;

    if (terms.length > 1 && title.includes(phrase)) score += WEIGHTS.title * 2;

    // Deep-link to the heading that matches the most terms.
    let heading;
    let best = 0;
    headings.forEach((hd, i) => {
      const hits = terms.filter((term) => hd.includes(term)).length;
      if (hits > best) { best = hits; heading = entry.headings[i]; }
    });

    acc.push({ entry, score, heading });
    return acc;
  }, []).sort((a, b) => b.score - a.score);
}

export function getSnippet(entry, terms) {
  const text = entry.content || entry.description;
  if (!text) return '';
  const lower = text.toLowerCase();
  const first = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (first === undefined) {
    return entry.description || text.slice(0, SNIPPET_LENGTH);
  }
  const start = Math.max(0, first - 40);
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

// Builds highlighted text with DOM nodes only (no innerHTML) so index content can't inject markup.
export function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) {
    frag.append(text);
    return frag;
  }
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  text.split(re).forEach((part, i) => {
    if (!part) return;
    if (i % 2) {
      const mark = document.createElement('mark');
      mark.textContent = part;
      frag.append(mark);
    } else {
      frag.append(part);
    }
  });
  return frag;
}

async function fetchIndex(name) {
  const { codeBase } = getConfig();
  const rows = [];
  let offset = 0;
  let total = Infinity;
  const limit = 500;
  while (offset < total) {
    const resp = await fetch(`${codeBase}/${name}?offset=${offset}&limit=${limit}`);
    if (resp.status === 401) {
      window.location.assign('/auth/logout');
      return new Promise(() => {});
    }
    if (!resp.ok) throw Error(`Could not fetch ${name}`);
    const json = await resp.json();
    rows.push(...json.data);
    total = json.total ?? rows.length;
    offset += limit;
  }
  return rows;
}

function loadIndex() {
  indexPromise ??= fetchIndex('search-index.json')
    .catch(() => fetchIndex('query-index.json'))
    .then((rows) => rows
      .filter((row) => row.path && !row.path.startsWith('/fragments/'))
      .map(normalizeEntry))
    .catch((e) => {
      indexPromise = undefined;
      throw e;
    });
  return indexPromise;
}

function renderResults(list, status, query, entries) {
  list.replaceChildren();
  const terms = tokenize(query);
  if (!terms.length) {
    status.textContent = '';
    return;
  }

  const results = search(query, entries).slice(0, MAX_RESULTS);
  status.textContent = results.length
    ? `${results.length}${results.length === MAX_RESULTS ? '+' : ''} results`
    : `No results for “${query.trim()}”`;

  results.forEach(({ entry, heading }, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `search-result-${i}`;

    const a = document.createElement('a');
    a.href = heading ? `${entry.path}#${slugify(heading)}` : entry.path;
    a.tabIndex = -1;

    const title = document.createElement('span');
    title.className = 'search-result-title';
    title.append(highlight(entry.title, terms));
    a.append(title);

    if (heading) {
      const section = document.createElement('span');
      section.className = 'search-result-heading';
      section.append(highlight(heading, terms));
      a.append(section);
    }

    const snippet = getSnippet(entry, terms);
    if (snippet) {
      const p = document.createElement('span');
      p.className = 'search-result-snippet';
      p.append(highlight(snippet, terms));
      a.append(p);
    }

    li.append(a);
    list.append(li);
  });
}

function setActive(input, list, index) {
  const items = [...list.children];
  items.forEach((li, i) => li.setAttribute('aria-selected', i === index ? 'true' : 'false'));
  const active = items[index];
  if (active) {
    input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function buildDialog() {
  const el = document.createElement('dialog');
  el.className = 'search-dialog';
  el.setAttribute('aria-label', 'Search');

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'search-input';
  input.placeholder = 'Search docs';
  input.setAttribute('aria-label', 'Search docs');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'search-results');
  input.autocomplete = 'off';

  const status = document.createElement('p');
  status.className = 'search-status';
  status.setAttribute('aria-live', 'polite');

  const list = document.createElement('ul');
  list.id = 'search-results';
  list.className = 'search-results';
  list.setAttribute('role', 'listbox');

  el.append(input, status, list);

  let active = -1;
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const entries = await loadIndex();
        renderResults(list, status, input.value, entries);
      } catch {
        status.textContent = 'Search is unavailable right now.';
      }
      active = list.children.length ? 0 : -1;
      setActive(input, list, active);
    }, 100);
  });

  input.addEventListener('keydown', (e) => {
    const count = list.children.length;
    if (e.key === 'ArrowDown' && count) {
      e.preventDefault();
      active = (active + 1) % count;
      setActive(input, list, active);
    } else if (e.key === 'ArrowUp' && count) {
      e.preventDefault();
      active = (active - 1 + count) % count;
      setActive(input, list, active);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      list.children[active]?.querySelector('a')?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      el.close();
    }
  });

  list.addEventListener('click', (e) => {
    if (e.target.closest('a')) el.close();
  });

  // Close when clicking the backdrop (outside the dialog box).
  el.addEventListener('click', (e) => {
    if (e.target === el) el.close();
  });

  document.body.append(el);
  return el;
}

export default function openSearch() {
  dialog ??= buildDialog();
  if (!dialog.open) dialog.showModal();
  const input = dialog.querySelector('.search-input');
  input.select();
  loadIndex().catch(() => {});
}
