import { useRef } from 'react';

/** Minimal YAML highlighter → HTML (keys, strings, comments, booleans, numbers). */
function highlight(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return src
    .split('\n')
    .map((raw) => {
      if (/^\s*#/.test(raw)) return `<span class="hl-c">${esc(raw)}</span>`;
      let line = esc(raw);
      // strings first (so later passes never rescan inserted markup)
      line = line.replace(/("[^"]*"|'[^']*')/g, '<span class="hl-s">$1</span>');
      // key at line start
      line = line.replace(/^(\s*(?:-\s*)?)([\w.$-]+)(:)(\s|$)/, (_, pre, key, colon, sp) =>
        `${pre}<span class="hl-k">${key}</span>${colon}${sp}`);
      // booleans / null (kept minimal to avoid false positives)
      line = line.replace(/\b(true|false|null)\b/g, '<span class="hl-b">$1</span>');
      // numbers after "key: "
      line = line.replace(/(:\s)(\d+(?:\.\d+)?)(\s|$)/g, (_, p, n, s) => `${p}<span class="hl-n">${n}</span>${s}`);
      return line;
    })
    .join('\n');
}

export default function CodeEditor({ value, onChange, minHeight = 320 }) {
  const preRef = useRef(null);
  const taRef = useRef(null);

  const sync = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  return (
    <div className="code-editor" style={{ minHeight }}>
      <pre className="code-hl" ref={preRef} aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: highlight(value || '') + '\n' }} />
      </pre>
      <textarea
        ref={taRef}
        className="code-input"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
        wrap="off"
      />
    </div>
  );
}
