export default (el) => {
  console.log(el.textContent);
  const authoredSpace = el.textContent;
  const div = document.createElement('div');
  div.className = `spacing ${authoredSpace}`;
  el.replaceWith(div);
};
