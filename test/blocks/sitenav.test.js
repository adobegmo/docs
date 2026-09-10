import { expect } from '@esm-bundle/chai';
import {
  formatSiteData,
  generateSiteList,
} from '../../blocks/sitenav/sitenav.js';

describe('formatSiteData', () => {
  it('Formats the pageData', () => {
    const data = [
      {
        path: '/index.html',
        title: 'Homepage',
      },
      {
        path: '/about/index.html',
        title: 'About',
        navOrder: 20,
      },
      {
        path: '/about/execs.html',
        title: 'Executives',
        navOrder: 10,
      },
    ];
    const formattedData = formatSiteData(data);
    console.log(data);
    console.log(JSON.stringify(formattedData));
  });
});

describe('generateSiteList', () => {
  it('parses the formatted data', () => {
    const data = {
      'index.html': { children: {}, title: 'Homepage', path: '/index.html' },
      about: {
        children: {
          'index.html': {
            children: {},
            title: 'About',
            path: '/about/index.html',
            navOrder: 20,
          },
          'execs.html': {
            children: {},
            title: 'Executives',
            path: '/about/execs.html',
            navOrder: 10,
          },
        },
        title: 'about',
        path: '/about',
      },
    };

    const ul = generateSiteList(data, '/about');
    console.log(ul)
  });
});
