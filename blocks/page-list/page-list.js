import { getConfig } from '../../scripts/ak.js';

const { codeBase } = getConfig();

async function fetchSiteData() {
  const resp = await fetch(`${codeBase}/query-index.json`);
  if (!resp.ok) throw Error('Could not fetch query index');
  const { data } = await resp.json();
  return data.sort((a, b) => {
    const segmentsA = a.path.split('/').length - 1;
    const segmentsB = b.path.split('/').length - 1;

    // First sort by depth
    if (segmentsA !== segmentsB) {
      return segmentsA - segmentsB;
    }

    // Then sort siblings by navOrder
    const orderA = a.navOrder;
    const orderB = b.navOrder;

    if (orderA !== undefined && orderB !== undefined) {
      return Number(orderA) - Number(orderB);
    }

    if (orderA !== undefined) return -1;
    if (orderB !== undefined) return 1;

    return 0;
  });
}

function createCards(siteData) {
  const cards = Object.keys(siteData).reduce((acc, key) => {
    const isPage = siteData[key].path === window.location.pathname;
    const notDescendant = !siteData[key].path.startsWith(window.location.pathname);

    if (isPage || notDescendant) return acc;

    const card = document.createElement('li');
    card.classList.add('docket-page-list-card');

    const link = document.createElement('a');
    link.href = siteData[key].path;

    const title = document.createElement('p');
    title.classList.add('docket-page-list-card-title');
    title.innerText = siteData[key].title;

    const description = document.createElement('p');
    description.classList.add('docket-page-list-card-description');
    description.innerText = siteData[key].description;

    link.append(title, description);
    card.append(link);
    acc.push(card);

    return acc;
  }, []);
  const ul = document.createElement('ul');
  ul.classList.add('docket-page-list');
  ul.append(...cards);
  return ul;
}

export default async function init(el) {
  try {
    const siteData = await fetchSiteData();
    const cards = createCards(siteData);
    el.append(cards);
  } catch (err) {
    console.error(err);
  }
}
