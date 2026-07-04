import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync('src/ui/styles/tokens.css', 'utf8');
const explorer = readFileSync('src/ui/styles/explorer.css', 'utf8');
const admin = readFileSync('src/ui/styles/admin.css', 'utf8');
const overlays = readFileSync('src/ui/styles/overlays.css', 'utf8');
const shell = readFileSync('src/ui/styles/shell.css', 'utf8');
const base = readFileSync('src/ui/styles/base.css', 'utf8');

function hex(name: string): string {
  const match = tokens.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match) throw new Error(`Missing ${name}`);
  return match[1];
}

function darkHex(name: string): string {
  const dark = tokens.match(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1];
  const match = dark?.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match) throw new Error(`Missing dark ${name}`);
  return match[1];
}

function luminance(value: string): number {
  const channels = value.slice(1).match(/.{2}/g)!.map((part) => Number.parseInt(part, 16) / 255).map((part) => part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left: string, right: string): number {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('visual style contracts', () => {
  it('keeps light primary buttons and muted text at WCAG AA contrast', () => {
    expect(contrast(hex('--color-primary'), hex('--color-primary-text'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex('--color-muted'), hex('--color-page'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex('--color-muted'), hex('--color-surface'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps distinct dark primary and hover tokens at WCAG AA contrast with white text', () => {
    const darkPrimary = darkHex('--color-primary');
    const darkHover = darkHex('--color-primary-hover');
    expect(darkPrimary).not.toBe(hex('--color-primary'));
    expect(darkHover).not.toBe(hex('--color-primary-hover'));
    expect(contrast(darkPrimary, hex('--color-primary-text'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkHover, hex('--color-primary-text'))).toBeGreaterThanOrEqual(4.5);
  });

  it('uses accessible semantic accent foregrounds on real dark surfaces', () => {
    const foreground = darkHex('--color-accent-foreground');
    const strongForeground = darkHex('--color-accent-foreground-strong');
    for (const surface of ['--color-surface', '--color-surface-raised', '--color-selected']) {
      expect(contrast(foreground, darkHex(surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(strongForeground, darkHex(surface))).toBeGreaterThanOrEqual(4.5);
    }

    expect(admin).toContain('color: var(--color-accent-foreground);');
    expect(explorer).toContain('background: var(--accent-soft); color: var(--color-accent-foreground-strong);');
    expect(overlays).toContain('.previewError a { color: var(--color-accent-foreground);');
    expect(overlays).toContain('color: var(--color-accent-foreground-strong);');
    expect(shell).toContain('.siteName:hover { color: var(--color-accent-foreground-strong); }');
    expect(base).toContain('background: var(--color-primary); color: var(--color-primary-text);');
  });

  it('keeps selection controls visible and mobile actions at least 48px', () => {
    expect(explorer).toContain('.entrySelect { opacity: 1; }');
    expect(explorer).toContain('.gridSelect { position: absolute; top: 10px; right: 10px; z-index: 1; opacity: 1; }');
    expect(explorer).toContain('.entryActions .iconButton { width: 48px; height: 48px; flex-basis: 48px; }');
    expect(explorer).toContain('.entrySelect, .entrySelectPlaceholder { grid-row: 1 / span 2; width: 48px; height: 56px; }');
    expect(explorer).toContain('.mobileAction, .mobileActionCancel { display: flex; align-items: center; width: 100%; min-height: 48px;');
    expect(explorer).toContain('.gridMenu { width: 48px; height: 48px; flex-basis: 48px;');
    expect(explorer).toContain('.entrySize { grid-column: 2; grid-row: 2;');
    expect(explorer).toContain('.entryOpen { grid-column: 2; grid-row: 1; min-height: 48px; height: 48px;');
  });

  it('animates the toolbar refresh icon while it is refreshing', () => {
    expect(explorer).toContain('.explorerToolbar .isSpinning { animation: spin 0.9s linear infinite; }');
  });

  it('keeps the compact command bar on one row with 48px mobile icon targets', () => {
    expect(explorer).toContain('.explorerToolbar { position: relative; display: flex; align-items: center; min-height: 54px;');
    expect(explorer).toMatch(/\.toolbarPath\s*\{[^}]*min-width: 0;[^}]*flex: 1 1 auto;[^}]*overflow: hidden;/);
    expect(explorer).toContain('.toolbarActions { position: relative; z-index: 2; margin-left: auto;');
    expect(explorer).toContain('.searchOverlay { width: 100%; min-width: 0; max-width: 360px; }');
    expect(explorer).toMatch(/\.sortControl select\s*\{[\s\S]*?width: auto;[\s\S]*?max-width: 88px;/);
    expect(explorer).toContain('.explorerToolbar .iconButton, .mobileViewToggle button { width: 48px; height: 48px; flex-basis: 48px; }');
    expect(explorer).toContain('.desktopViewToggle, .desktopAdminActions { display: none; }');
    expect(explorer).toContain('.mobileViewToggle, .mobileAdminActions { display: inline-flex; }');
    expect(explorer).not.toContain('.directoryCommands');
    expect(explorer).not.toContain('.explorerToolbar { align-items: stretch; flex-wrap: wrap; }');
    expect(explorer).not.toContain('.toolbarActions { width: 100%; justify-content: flex-start; }');
    expect(explorer).toContain('.explorerPage { width: 100%; padding-top: 12px; }');
    expect(explorer).toContain('.explorerToolbar, .toolbarActions { gap: 0; }');
    expect(explorer).toContain('.sortControl select { width: 64px; max-width: 64px;');
  });

  it('keeps the site header and command bar transparent so only the file list carries surface color', () => {
    expect(shell).toContain('background: transparent;');
    expect(shell).toMatch(/\.siteHeader\s*\{[\s\S]*?background: transparent;/);
    expect(shell).toMatch(/\.siteHeader\s*\{[\s\S]*?border-bottom: 0;/);
    expect(explorer).toMatch(/\.explorerBrowser\s*\{[\s\S]*?background: transparent;/);
    expect(explorer).toMatch(/\.explorerToolbar\s*\{[\s\S]*?background: transparent;/);
    expect(explorer).toMatch(/\.explorerContent\s*\{[\s\S]*?background: var\(--surface\);/);
    expect(explorer).toMatch(/\.explorerContent\s*\{[\s\S]*?border: 1px solid var\(--line\);/);
  });
});
