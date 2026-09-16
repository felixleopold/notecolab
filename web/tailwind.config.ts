/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [],
  theme: {
    extend: {
      colors: {
        obsidian: {
          bg: '#1e1e1e',
          surface: '#262626',
          border: '#363636',
          text: '#dcddde',
          muted: '#999',
          accent: '#7f6df2',
          'accent-hover': '#8b7cf3',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
