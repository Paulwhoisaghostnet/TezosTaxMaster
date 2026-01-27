'use client';

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from './ThemeProvider';

export default function ThemeToggle() {
  const { theme, setTheme, resolvedTheme, mounted } = useTheme();

  const cycleTheme = () => {
    if (theme === 'light') setTheme('dark');
    else if (theme === 'dark') setTheme('system');
    else setTheme('light');
  };

  // Render placeholder during SSR to avoid hydration mismatch
  if (!mounted) {
    return (
      <button
        className="p-2 text-gray-500 dark:text-gray-400 rounded-lg"
        aria-label="Toggle theme"
      >
        <Sun className="w-5 h-5" />
      </button>
    );
  }

  return (
    <button
      onClick={cycleTheme}
      className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      aria-label={`Current theme: ${theme}. Click to change.`}
      title={`Theme: ${theme === 'system' ? `System (${resolvedTheme})` : theme}`}
    >
      {theme === 'system' ? (
        <Monitor className="w-5 h-5" />
      ) : theme === 'dark' ? (
        <Moon className="w-5 h-5" />
      ) : (
        <Sun className="w-5 h-5" />
      )}
    </button>
  );
}
