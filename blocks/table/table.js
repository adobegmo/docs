export default function init(el) {
  const rows = [...el.children];
  if (!rows.length) return;

  const headers = [...rows[0].children].map((cell) => cell.textContent.trim());

  // Read the raw class attribute (not classList) so repeated widths like
  // `col-20 col-20` are preserved — DOMTokenList dedupes duplicate tokens.
  const widths = (el.getAttribute('class') || '')
    .split(/\s+/)
    .map((cls) => cls.match(/^col-(\d+)$/))
    .filter(Boolean)
    .map((match) => Number(match[1]));

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');

  for (const [rowIdx, row] of rows.entries()) {
    const isHeader = rowIdx === 0;
    const tr = document.createElement('tr');
    tr.classList.add(isHeader ? 'table-heading-row' : 'table-content-row');

    for (const [colIdx, cell] of [...row.children].entries()) {
      const newCell = document.createElement(isHeader ? 'th' : 'td');
      if (isHeader) {
        newCell.setAttribute('scope', 'col');
      } else if (headers[colIdx]) {
        newCell.dataset.label = headers[colIdx];
      }
      newCell.append(...cell.childNodes);
      tr.append(newCell);
    }

    (isHeader ? thead : tbody).append(tr);
  }

  if (widths.length) {
    const colgroup = document.createElement('colgroup');
    for (let i = 0; i < headers.length; i += 1) {
      const col = document.createElement('col');
      if (widths[i]) col.style.setProperty('--col-width', `${widths[i]}%`);
      colgroup.append(col);
    }
    table.append(colgroup);
  }

  table.append(thead, tbody);
  el.replaceChildren(table);
}
