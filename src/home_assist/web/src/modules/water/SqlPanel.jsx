import { useState } from 'react';

/**
 * SqlPanel — "where did this chart come from?", answered exactly rather than approximately.
 *
 * The server builds these strings from the SAME parameters the queries actually ran with, so the
 * text here can be pasted into Workbench and return the rows the chart drew. That is the whole
 * point: a hand-written copy in the UI drifts the first time someone changes a WHERE clause, and a
 * chart you cannot reproduce is a chart you cannot argue with.
 *
 * Closed by default. It is reference material, not something to read every visit.
 */
export default function SqlPanel({ blocks }) {
  const [copied, setCopied] = useState('');
  if (!blocks || !blocks.length) return null;

  const copy = (b) => {
    try {
      navigator.clipboard.writeText(b.text);
      setCopied(b.label);
      setTimeout(() => setCopied(''), 1600);
    } catch (e) { /* clipboard blocked (http, or an old browser) — the text is on screen anyway */ }
  };

  return (
    <details className="w-sql">
      <summary>Data source &amp; SQL</summary>
      <div className="w-sql-body">
        {blocks.map((b) => (
          <div className="w-sql-block" key={b.label}>
            <div className="w-sql-head">
              <span className="w-sql-label">{b.label}</span>
              <code className="w-sql-table">{b.table}</code>
              <button type="button" className="w-sql-copy" onClick={() => copy(b)}>
                {copied === b.label ? '✓ copied' : '⧉ copy'}
              </button>
            </div>
            <pre>{b.text}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}
