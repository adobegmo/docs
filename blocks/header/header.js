import { getConfig, getMetadata, loadBlock, loadStyle } from '../../scripts/ak.js';
import getSvg from '../../scripts/utils/svg.js';
import { loadFragment } from '../fragment/fragment.js';

const { locale, codeBase } = getConfig();

const HEADER_PATH = '/fragments/nav/header';

function decorateBrand(el) {
  el.classList.add('brand-section');
}

function decorateMainNav(el) {
  el.classList.add('main-nav-section');
}

async function decorateLink(section, pattern, name) {
  const link = section.querySelector(`[href*="${pattern}"]`);
  if (!link) return;

  link.setAttribute('aria-label', link.textContent);
  const svg = await getSvg({ paths: [`${codeBase}/img/logos/${name}.svg`] });
  link.innerHTML = '';
  link.append(svg[0]);
  link.target = '_blank';
  link.classList.add('decorated');

  if (name === 'color') {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const { body } = document;

      let currPref = localStorage.getItem('color-scheme');
      if (!currPref) {
        currPref = matchMedia('(prefers-color-scheme: dark)')
          .matches ? 'dark-scheme' : 'light-scheme';
      }

      const scheme = currPref === 'dark-scheme'
        ? { add: 'light-scheme', remove: 'dark-scheme' }
        : { add: 'dark-scheme', remove: 'light-scheme' };

      body.classList.remove(scheme.remove);
      body.classList.add(scheme.add);
      localStorage.setItem('color-scheme', scheme.add);
    });
  }
}

const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15ZM16 16l5 5"/></svg>';

let searchModule;
async function openSearch() {
  searchModule ??= Promise.all([
    import('./search.js'),
    loadStyle(`${codeBase}/blocks/header/search.css`),
  ]);
  const [{ default: open }] = await searchModule;
  open();
}

function isEditable(el) {
  return el?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName);
}

function decorateSearch(section) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'search-button';
  button.setAttribute('aria-label', 'Search (Ctrl+K)');
  button.innerHTML = SEARCH_ICON;
  button.addEventListener('click', openSearch);
  (section.querySelector('.default-content') || section).prepend(button);

  document.addEventListener('keydown', (e) => {
    const shortcut = (e.key === 'k' && (e.metaKey || e.ctrlKey))
      || (e.key === '/' && !isEditable(document.activeElement));
    if (!shortcut) return;
    e.preventDefault();
    openSearch();
  });
}

async function decorateActions(section) {
  section.classList.add('actions-section');
  decorateSearch(section);
  const color = decorateLink(section, '/tools/widgets/theme', 'color');
  const discord = decorateLink(section, 'discord.com', 'discord');
  const github = decorateLink(section, 'github.com', 'github');
  await Promise.all([color, discord, github]);

  // Profile / sign-out menu (imslib). Mounted as its own block (lazy JS + CSS).
  // Deliberately NOT awaited: imslib can take up to its timeout to resolve, and
  // the header must not wait on it to render.
  const profile = document.createElement('div');
  profile.className = 'profile';
  section.append(profile);
  loadBlock(profile);
}

async function decorateHeader(fragment) {
  const img = fragment.querySelector('.section:first-child img');
  if (img) {
    const brand = img.closest('.section');
    decorateBrand(brand);
  }

  const ul = fragment.querySelector('ul');
  if (ul) {
    const mainNav = ul.closest('.section');
    decorateMainNav(mainNav);
  }

  const actions = fragment.querySelector('.section:last-child');

  // Only decorate the action area if it has not been decorated
  if (actions?.classList.length < 2) await decorateActions(actions);
}

/**
 * loads and decorates the header
 * @param {Element} el The header element
 */
export default async function init(el) {
  const headerMeta = getMetadata('header');
  const path = headerMeta || HEADER_PATH;
  try {
    const fragment = await loadFragment(`${locale.prefix}${path}`);
    fragment.classList.add('header-content');
    await decorateHeader(fragment);
    el.append(fragment);
  } catch (e) {
    throw Error(e);
  }
}
