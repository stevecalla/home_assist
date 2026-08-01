import { useEffect, useState } from 'react';
import { apply_theme, effective_dark, toggle_theme, watch_system } from '../lib/theme.js';
import { track } from '../lib/track.js';

// ☀/☾ light-dark toggle. Stored choice wins; otherwise follows the OS.
export default function ThemeToggle() {
  const [dark, setDark] = useState(effective_dark());

  useEffect(() => {
    apply_theme();
    // When following the OS (no stored choice) and the OS theme flips, re-apply AND resync the button.
    watch_system(() => { apply_theme(); setDark(effective_dark()); });
  }, []);

  const onClick = () => { toggle_theme(); const d = effective_dark(); setDark(d); try { track('theme_change', { panel: 'app', view: d ? 'dark' : 'light', filter_name: d ? 'dark' : 'light' }); } catch (e) { /* best-effort */ } };

  return (
    <button
      className="btn"
      data-theme-toggle
      aria-label="Toggle light or dark theme"
      title={'Switch to ' + (dark ? 'light' : 'dark') + ' theme'}
      onClick={onClick}
    >
      {dark ? '☀ Light' : '☾ Dark'}
    </button>
  );
}
