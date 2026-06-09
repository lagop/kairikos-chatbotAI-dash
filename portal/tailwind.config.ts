import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        kairikos: {
          bg: '#0B1020',
          surface: '#121933',
          surface2: '#1A2147',
          border: '#2A3565',
          text: '#E6EBFF',
          muted: '#9AA3C7',
          accent: '#7C5CFF',
          accent2: '#3DC7F6',
          success: '#34D399',
          warning: '#F59E0B',
          danger: '#F87171',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      maxWidth: {
        page: '960px',
      },
    },
  },
  plugins: [],
};

export default config;
