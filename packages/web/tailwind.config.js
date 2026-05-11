/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: '#0A0F14',
        surface: {
          DEFAULT: '#0F1620',
          2: '#141C28',
          3: '#1B2533',
        },
        border: {
          subtle: '#1F2A38',
          strong: '#2B3A4D',
        },
        fg: {
          DEFAULT: '#E6EDF3',
          secondary: '#9BA8B7',
          muted: '#5F6E7E',
          disabled: '#3D4A5A',
        },
        up: { DEFAULT: '#26D782', soft: '#0F4A2F' },
        down: { DEFAULT: '#FF5C7A', soft: '#4A1620' },
        warn: '#F5A524',
        info: '#56A6FF',
        ai: '#5BE3D6',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      fontVariantNumeric: {
        tabular: 'tabular-nums',
      },
    },
  },
  plugins: [],
};
