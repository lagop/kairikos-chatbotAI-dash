import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // WP-27 — each token reads from the CSS custom property defined in
        // globals.css (RGB triplet), not a fixed hex, so ThemeToggle can
        // switch the whole palette at runtime. The `<alpha-value>`
        // placeholder is filled in by Tailwind for opacity modifiers like
        // `bg-kairikos-accent/90`.
        kairikos: {
          bg: 'rgb(var(--kairikos-bg) / <alpha-value>)',
          surface: 'rgb(var(--kairikos-surface) / <alpha-value>)',
          surface2: 'rgb(var(--kairikos-surface2) / <alpha-value>)',
          border: 'rgb(var(--kairikos-border) / <alpha-value>)',
          text: 'rgb(var(--kairikos-text) / <alpha-value>)',
          muted: 'rgb(var(--kairikos-muted) / <alpha-value>)',
          accent: 'rgb(var(--kairikos-accent) / <alpha-value>)',
          accent2: 'rgb(var(--kairikos-accent2) / <alpha-value>)',
          success: 'rgb(var(--kairikos-success) / <alpha-value>)',
          warning: 'rgb(var(--kairikos-warning) / <alpha-value>)',
          danger: 'rgb(var(--kairikos-danger) / <alpha-value>)',
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
