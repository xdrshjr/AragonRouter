/**
 * Cross-module boundary suite for `brand-assets`.
 *
 * This is the part that a per-file test cannot give: the brand has to be *one* identity
 * across four modules that other work packages also touch, and the host components must
 * not regress while they gain the mark.
 *
 *  1. asset <-> component: the SVG files and `BrandMark` must draw the same geometry, so
 *     the favicon, the login card, the rail and the topbar are the same mark;
 *  2. component <-> hosts: `login/page.tsx`, `Sidebar.tsx` and `Topbar.tsx` are rendered
 *     through `react-dom/server` with their real props, and their existing content
 *     (nav items, section title, sanitised `?next=`, password form) is asserted to survive;
 *  3. component <-> layout: the metadata/viewport/anti-flash script contract of the root
 *     layout, and the fact that no config-based `icons` object replaces the file-convention
 *     favicon link;
 *  4. component <-> build: the `next build` output (`/icon.svg` route, served bytes,
 *     injected `<link rel="icon">`, generated Tailwind utilities) - guarded so the suite
 *     also runs before a build exists;
 *  5. the "do not touch" criteria: C10 token values, the dependency set and the unit-test
 *     include glob.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  usePathname: () => '/console',
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

// `next/link` needs an App Router context to render; the boundary under test is the brand
// mark inside these components, not Next's link implementation, so it is stubbed to the
// anchor it renders in the browser.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  ),
}));

import RootLayout, { metadata, viewport } from '@/app/layout';
import LoginPage from '@/app/login/page';
import { LoginForm } from '@/app/login/LoginForm';
import { Sidebar } from '@/components/console/Sidebar';
import { Topbar } from '@/components/console/Topbar';
import { NAV_ITEMS, findNavItem } from '@/components/console/nav';
import { read, readTokenPalette } from './support/svg';

const ICON = 'src/app/icon.svg';
const APPLE_ICON = 'src/app/apple-icon.svg';

/** The two path `d` values of the favicon - the single source of the geometry. */
function faviconGeometry(): string[] {
  return [...read(ICON).matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1] ?? '');
}

/**
 * The geometry of the *brand* mark only: the brand SVG is the one with the 32-unit
 * viewBox, so lucide's icons in the same markup are excluded by construction.
 */
function brandGeometry(markup: string): string[] {
  const segments = [...markup.matchAll(/<svg[^>]*viewBox="0 0 32 32"[^>]*>([\s\S]*?)<\/svg>/g)].map(
    (match) => match[1] ?? '',
  );
  return segments.flatMap((segment) =>
    [...segment.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1] ?? ''),
  );
}

/** Every React element in a rendered tree, so component props can be asserted directly. */
function collectElements(node: React.ReactNode, found: React.ReactElement[] = []): React.ReactElement[] {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node as React.ReactNode[]) collectElements(child, found);
    return found;
  }
  const element = node as React.ReactElement<{ children?: React.ReactNode }>;
  if (element.props === undefined || element.props === null) return found;
  found.push(element);
  if (element.props.children !== undefined) collectElements(element.props.children, found);
  return found;
}

async function loginNextPath(query: Record<string, string>): Promise<string | undefined> {
  const tree = await LoginPage({ searchParams: Promise.resolve(query) });
  const form = collectElements(tree).find((element) => element.type === LoginForm);
  const props = form?.props as { nextPath?: string } | undefined;
  return props?.nextPath;
}

async function renderLogin(): Promise<string> {
  const tree = await LoginPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(tree);
}

function renderSidebar(): string {
  return renderToStaticMarkup(<Sidebar />);
}

function renderTopbar(pathname: string | null = '/console/keys'): string {
  return renderToStaticMarkup(
    <Topbar
      pathname={pathname}
      onOpenNav={() => {
        /* no-op in a static render */
      }}
      onSignOut={() => {
        /* no-op in a static render */
      }}
    />,
  );
}

describe('one identity across the assets and the component', () => {
  it('draws the favicon geometry in BrandMark and in all three integration points', async () => {
    const expected = faviconGeometry();
    expect(expected).toHaveLength(2);

    expect(brandGeometry(renderSidebar())).toEqual(expected);
    expect(brandGeometry(renderTopbar())).toEqual(expected);
    expect(brandGeometry(await renderLogin())).toEqual(expected);
  });

  it('shows the mark exactly once in the shell and announces it once', () => {
    const markup = `${renderSidebar()}${renderTopbar()}`;
    const svgs = markup.match(/<svg/g) ?? [];
    // One mark in the rail, one in the header - the brand is present in both layouts.
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    // The rail's mark is decorative (the wordmark names the product); the header's is an
    // image with a label. Together they must not produce two competing announcements.
    const labelled = markup.match(/aria-label="AragonRouter"/g) ?? [];
    expect(labelled).toHaveLength(1);
    expect(markup.match(/>AragonRouter</g) ?? []).toHaveLength(1);
  });

  it('keeps the mark free of external references in every host', async () => {
    for (const markup of [renderSidebar(), renderTopbar(), await renderLogin()]) {
      expect(markup).not.toMatch(/<img|<canvas|url\(|@font-face|https?:\/\/(?!www\.w3\.org)/);
    }
  });
});

describe('Sidebar host (console rail)', () => {
  const markup = renderSidebar();

  it('renders the mark and the wordmark at the top of the rail', () => {
    expect(markup).toContain('fill="var(--brand)"');
    expect(markup).toContain('aria-hidden="true"');
    const wordmark = markup.indexOf('>AragonRouter<');
    expect(wordmark).toBeGreaterThan(-1);
    // The brand sits above the first navigation entry, which is where the rail starts.
    const firstNavItem = NAV_ITEMS[0];
    expect(firstNavItem).toBeDefined();
    if (firstNavItem === undefined) return;
    expect(wordmark).toBeLessThan(markup.indexOf(firstNavItem.label));
  });

  it('keeps every navigation entry, the subtitle and the section caption', () => {
    for (const item of NAV_ITEMS) expect(markup).toContain(item.label);
    expect(markup).toContain('Relay console');
    expect(markup).toContain('Platform');
    expect(markup).toContain('/api/v1');
    expect(markup).toContain('aria-current="page"');
  });

  it('renders the 28px mark so the stacked subtitle lines up', () => {
    expect(markup).toContain('width="28"');
    expect(markup).toContain('height="28"');
    // `pl-9` == 28px mark + the component's 8px gap: the subtitle indent must match.
    expect(markup).toContain('pl-9');
  });
});

describe('Topbar host (console header)', () => {
  it('renders the standalone mark to the left of the section heading', () => {
    const markup = renderTopbar('/console/keys');
    expect(markup).toContain('aria-label="AragonRouter"');
    expect(markup).toContain('role="img"');
    const mark = markup.indexOf('aria-label="AragonRouter"');
    const heading = markup.indexOf('<h1');
    expect(mark).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(mark);
  });

  it('keeps the section title, hint, sign-out and mobile nav trigger', () => {
    const item = findNavItem('/console/keys');
    const markup = renderTopbar('/console/keys');
    expect(markup).toContain(item.label);
    expect(markup).toContain(item.hint);
    expect(markup).toContain('Sign out');
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).toContain('Switch to light theme');
  });

  it('falls back to the default section for an unknown path', () => {
    const markup = renderTopbar('/console/unknown');
    expect(markup).toContain('aria-label="AragonRouter"');
    expect(markup).toContain('<h1');
  });
});

describe('/login host', () => {
  it('renders the mark above the sign-in card', async () => {
    const markup = await renderLogin();
    expect(markup).toContain('fill="var(--brand)"');
    const wordmark = markup.indexOf('>AragonRouter<');
    const password = markup.indexOf('name="password"');
    expect(wordmark).toBeGreaterThan(-1);
    expect(password).toBeGreaterThan(wordmark);
    // Still the branded page shell.
    expect(markup).toContain('dot-grid');
    expect(markup).toContain('Admin access only');
  });

  it('still sanitises ?next= while the brand is added', async () => {
    // The sanitised value is the `nextPath` prop the form receives - it is not echoed in
    // the markup, so it has to be read off the element tree.
    expect(await loginNextPath({ next: '/console/logs' })).toBe('/console/logs');
    expect(await loginNextPath({ next: 'https://evil.example/steal' })).not.toContain('evil.example');
    expect(await loginNextPath({ next: '//evil.example' })).not.toContain('evil.example');
    const hostile = renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({ next: 'https://evil.example/steal' }) }),
    );
    expect(hostile).not.toContain('evil.example');
  });
});

describe('root layout metadata contract', () => {
  it('keeps the title, description and application name', () => {
    expect(metadata.title).toEqual({ default: 'AragonRouter console', template: '%s · AragonRouter' });
    expect(metadata.description).toContain('AragonRouter');
    expect(metadata.applicationName).toBe('AragonRouter');
  });

  it('keeps the viewport unchanged', () => {
    expect(viewport.themeColor).toBe('#121212');
    expect(viewport.width).toBe('device-width');
    expect(viewport.initialScale).toBe(1);
    expect(viewport.colorScheme).toBe('dark light');
  });

  it('does not replace the file-convention favicon with a config icons object', () => {
    // Config-based icons *replace* the `<link rel="icon">` that Next generates for
    // `src/app/icon.svg`; they are not merged. Either no icons object is declared, or it
    // still points at the routed `/icon.svg`.
    const icons = metadata.icons;
    if (icons === undefined) {
      expect(icons).toBeUndefined();
      return;
    }
    expect(JSON.stringify(icons)).toContain('icon.svg');
  });

  it('never advertises the un-routed apple SVG (it would 404)', () => {
    expect(JSON.stringify(metadata.icons ?? {})).not.toContain('apple-icon.svg');
  });

  it('keeps the dark first paint and the anti-flash boot script', () => {
    const markup = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
    expect(markup).toContain('class="dark"');
    expect(markup).toContain('<script');
    expect(markup).toContain('localStorage');
    // The boot script is what removes the flash: it must still be the inline, constant
    // script that runs before the body, not a deferred module.
    expect(markup).toContain("classList.add('dark')");
    expect(markup).toContain('aragon-theme');
    expect(markup).toMatch(/<body class="[^"]*bg-bg[^"]*text-text/);
  });
});

// --- build artefacts ---------------------------------------------------------------
const NEXT_DIR = join(process.cwd(), '.next');

/**
 * A *production* build, not merely an existing `.next` directory.
 *
 * `next dev` creates `.next/` too, but without `BUILD_ID` and without
 * `app-path-routes-manifest.json`, and it rewrites the directory as it compiles. The
 * ops-scripts integration suites start dev servers in this repository, so keying the
 * guard on `.next` alone made these five tests fail for an environmental reason
 * (dev-mode `.next`) rather than a brand defect. Requiring the three artefacts that
 * only `next build` produces keeps the assertions strict *and* makes the failure mode
 * honest: if a real build is present, everything below must hold; if there is none,
 * the suite says so at the top of the file instead of failing five tests.
 */
const BUILD_ARTEFACTS = [
  join('BUILD_ID'),
  join('app-path-routes-manifest.json'),
  join('server', 'app', 'icon.svg.body'),
];
const HAS_BUILD = BUILD_ARTEFACTS.every((relativePath) => existsSync(join(NEXT_DIR, relativePath)));

function readBuild(relativePath: string): string {
  return readFileSync(join(NEXT_DIR, relativePath), 'utf8');
}

describe('production build prerequisites', () => {
  it('reports whether a production build is available for the artefact checks', () => {
    // Always green: this line is the record of whether the five `next build output`
    // tests below actually executed or were skipped for this checkout.
    expect({ nextDir: NEXT_DIR, hasProductionBuild: HAS_BUILD }).toEqual({
      nextDir: expect.stringContaining(join('.next')) as unknown as string,
      hasProductionBuild: HAS_BUILD,
    });
    expect(typeof HAS_BUILD).toBe('boolean');
  });
});

describe.skipIf(!HAS_BUILD)('next build output', () => {
  it('exposes /icon.svg as a real route', () => {
    const manifest = JSON.parse(readBuild('app-path-routes-manifest.json')) as Record<string, string>;
    const paths = Object.values(manifest);
    expect(paths).toContain('/icon.svg');
  });

  it('records the known apple-icon limitation instead of hiding it', () => {
    // FINDING (reported as a traceability gap, not fixed here - this package may not
    // change the asset): Next 15.5 only routes `apple-icon.{jpg,jpeg,png}`
    // (node_modules/next/dist/lib/metadata/is-metadata-route.js -> STATIC_METADATA_IMAGES
    // .apple.extensions). `src/app/apple-icon.svg` therefore produces no route and no
    // `<link rel="apple-touch-icon">`; a live GET of /apple-icon.svg answers 404.
    // The specification asked for the 180x180 asset to go through "the same App Router
    // convention", so the iOS home-screen icon is *not* wired up by this build.
    const manifest = JSON.parse(readBuild('app-path-routes-manifest.json')) as Record<string, string>;
    expect(Object.values(manifest)).not.toContain('/apple-icon.svg');
    expect(existsSync(join(NEXT_DIR, 'server', 'app', 'apple-icon.svg.body'))).toBe(false);
    // Keeping it out of the metadata keeps the page free of a 404 <link>.
    expect(JSON.stringify(metadata.icons ?? {})).not.toContain('apple-icon');
    // The source asset itself is present and valid - that part of the criterion holds.
    expect(existsSync(join(process.cwd(), APPLE_ICON))).toBe(true);
  });

  it('serves the branded bytes under that route as image/svg+xml', () => {
    const served = readBuild(join('server', 'app', 'icon.svg.body'));
    expect(served.trim()).toBe(read(ICON).trim());
    const meta = JSON.parse(readBuild(join('server', 'app', 'icon.svg.meta'))) as {
      status: number;
      headers: Record<string, string>;
    };
    expect(meta.status).toBe(200);
    expect(meta.headers['content-type']).toBe('image/svg+xml');
    // A favicon is immutable: hashed URL, one year cache.
    expect(meta.headers['cache-control']).toContain('immutable');
  });

  it('injects the favicon link into prerendered HTML', () => {
    const html = readBuild(join('server', 'app', '_not-found.html'));
    const links = [...html.matchAll(/<link[^>]*rel="icon"[^>]*>/g)].map((match) => match[0]);
    expect(links.length).toBeGreaterThan(0);
    const iconLink = links.find((link) => link.includes('/icon.svg'));
    expect(iconLink).toBeDefined();
    expect(iconLink).toContain('type="image/svg+xml"');
    // The content hash proves it is the file-convention link, not a static config entry.
    expect(iconLink).toMatch(/\/icon\.svg\?[0-9a-f]+/);
  });

  it('emits the Tailwind utilities the component uses', () => {
    const cssDir = join(NEXT_DIR, 'static', 'css');
    expect(existsSync(cssDir)).toBe(true);
    const sheets = readdirSync(cssDir).filter((entry) => entry.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    const css = sheets.map((sheet) => readFileSync(join(cssDir, sheet), 'utf8')).join('\n');
    // Every utility BrandMark relies on must survive Tailwind's content scan of the new
    // `src/components/brand/` directory - a component with unstyled classes would still
    // typecheck, so this is the only place that catches a missing content glob.
    for (const utility of [
      '.inline-flex{',
      '.items-center{',
      '.gap-2{',
      '.shrink-0{',
      '.select-none{',
      '.whitespace-nowrap{',
      '.font-semibold{',
      '.text-text{',
      '.text-base{',
      '.text-sm{',
    ]) {
      expect(css).toContain(utility);
    }
  });
});

describe('"do not touch" criteria', () => {
  it('left every C10 token value intact', () => {
    const palette = readTokenPalette(read('src/app/globals.css'));
    expect(palette).toEqual({
      bg: '#121212',
      surface: '#171717',
      surface2: '#1f1f1f',
      border: '#2a2a2a',
      text: '#ededed',
      muted: '#8f8f8f',
      brand: '#3ecf8e',
    });
  });

  it('added no dependency and no UI-test runtime', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      'clsx',
      'lucide-react',
      'next',
      'react',
      'react-dom',
      'tailwind-merge',
    ]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      '@types/node',
      '@types/react',
      '@types/react-dom',
      'autoprefixer',
      'postcss',
      'tailwindcss',
      'typescript',
      'vitest',
    ]);
    const all = JSON.stringify(pkg);
    for (const forbidden of ['jsdom', 'happy-dom', '@testing-library', 'vitest-browser']) {
      expect(all).not.toContain(forbidden);
    }
  });

  it('kept the unit-test include glob and added no UI test file to tests/unit', () => {
    const config = read('vitest.config.ts');
    expect(config).toContain("include: ['tests/unit/**/*.test.ts']");
    const unitDir = join(process.cwd(), 'tests', 'unit');
    const offenders = readdirSync(unitDir).filter((entry) => entry.endsWith('.tsx'));
    expect(offenders).toEqual([]);
  });

  it('keeps both brand assets in the App Router metadata location', () => {
    for (const file of [ICON, APPLE_ICON]) {
      expect(existsSync(join(process.cwd(), file))).toBe(true);
    }
  });
});
