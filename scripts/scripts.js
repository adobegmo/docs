import { loadArea, loadBlock, setConfig } from './ak.js';

// Supported locales
const locales = { '': { ietf: 'en', tk: 'etj3wuq.css' } };

// Blocks built by links
const linkBlocks = [
  { fragment: '/fragments/' },
  { youtube: 'https://www.youtube' },
];

// Blocks with self-managed styles
const components = ['fragment'];

// All off origin links open in a new window
function decorateLinks(area) {
  const anchors = area.querySelectorAll('a');
  for (const a of anchors) {
    const { href } = a;
    const { origin } = new URL(href);
    if (origin !== window.location.origin) {
      a.setAttribute('target', '_blank');
    }
  }
}

// How to decorate an area before loading it
const decorateArea = ({ area = document }) => {
  const eagerLoad = (parent, selector) => {
    const img = parent.querySelector(selector);
    img?.removeAttribute('loading');
  };

  decorateLinks(area);
  eagerLoad(area, 'img');
};

const loadNav = async (name) => {
  const position = name === 'sitenav' ? 'beforebegin' : 'afterend';
  const main = document.querySelector('main');
  const nav = document.createElement('nav');
  nav.dataset.status = 'decorated';
  nav.className = name;
  main.insertAdjacentElement(position, nav);
  await loadBlock(nav);
};

(async function loadPage() {
  setConfig({ locales, linkBlocks, components, decorateArea });

  // AK functions
  await loadArea();

  // Lazy project functions
  loadNav('sitenav');
}());
