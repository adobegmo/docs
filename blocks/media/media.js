export default function init(el) {
  [...el.classList].forEach((cls) => {
    if (cls.startsWith('size-')) {
      el.style = `--media-width: ${cls.replace('size-', '')}%`;
    }
  });
}
