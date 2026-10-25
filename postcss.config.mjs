/**
 * PostCSS pipeline for Next.js.
 *
 * Tailwind 3.4 is driven by `tailwind.config.ts`; autoprefixer keeps the console
 * usable on the older Safari/Edge builds an operator may still hit. No extra
 * plugins are installed, matching the approved dependency set.
 *
 * @type {import('postcss-load-config').Config}
 */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
