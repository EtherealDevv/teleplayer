import type { AppSettings } from '../../shared/types'
import { argbFromHex, Hct, hexFromArgb } from '@material/material-color-utilities'

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveDark(mode: AppSettings['themeMode']): boolean {
  if (mode === 'system') return prefersDark()
  return mode === 'dark'
}

function withTone(seed: Hct, tone: number): string {
  return hexFromArgb(Hct.from(seed.hue, seed.chroma, tone).toInt())
}

function tokenMap(dark: boolean, seedHex: string): Record<string, string> {
  const seed = Hct.fromInt(argbFromHex(seedHex))
  const accentTone = dark
    ? Math.min(72, Math.max(55, seed.tone))
    : Math.min(58, Math.max(42, seed.tone))
  const accent = withTone(seed, accentTone)
  const accentHover = withTone(seed, dark ? accentTone + 5 : accentTone - 5)
  const accentPressed = withTone(seed, dark ? accentTone - 5 : accentTone - 10)
  const accentSoft = withTone(seed, dark ? 30 : 92)
  const accentSoftStrong = withTone(seed, dark ? 24 : 88)
  const accentLight = withTone(seed, dark ? 78 : 66)
  const onAccent = accentTone > 66 ? '#101418' : '#ffffff'

  const light = {
    text: '#1a1a1a',
    secondary: '#707579',
    sidebar: '#ffffff',
    titlebar: '#ffffff',
    chat: '#dfe8f0',
    header: '#ffffff',
    card: '#ffffff',
    modal: '#ffffff',
    input: '#f1f2f3',
    search: '#f1f2f3',
    hover: '#f4f4f5',
    divider: '#e6e8ea',
    bubbleIn: '#ffffff',
    bubbleOut: '#eeffde',
    bubbleOutText: '#1a1a1a',
    bubbleOutMeta: 'rgba(0, 0, 0, 0.45)',
    menu: '#ffffff',
    pinned: '#ffffff',
    settings: '#f4f4f5',
    composer: '#ffffff',
    scrim: 'rgba(0, 0, 0, 0.38)'
  }

  const darkMap = {
    text: '#f5f5f5',
    secondary: '#aaaaaa',
    sidebar: '#212121',
    titlebar: '#212121',
    chat: '#15181c',
    header: '#212121',
    card: '#212121',
    modal: '#2b2b2b',
    input: '#2b2b2b',
    search: '#2b2b2b',
    hover: '#2b2b2b',
    divider: '#303030',
    bubbleIn: '#212121',
    bubbleOut: '#2b5278',
    bubbleOutText: '#ffffff',
    bubbleOutMeta: 'rgba(255, 255, 255, 0.58)',
    menu: '#2b2b2b',
    pinned: '#212121',
    settings: '#181818',
    composer: '#212121',
    scrim: 'rgba(0, 0, 0, 0.55)'
  }

  const c = dark ? darkMap : light

  return {
    '--tg-accent': accent,
    '--tg-accent-hover': accentHover,
    '--tg-accent-pressed': accentPressed,
    '--tg-accent-soft': accentSoft,
    '--tg-accent-soft-strong': accentSoftStrong,
    '--tg-accent-light': accentLight,
    '--tg-on-accent': onAccent,
    '--tg-text': c.text,
    '--tg-text-secondary': c.secondary,
    '--tg-sidebar-bg': c.sidebar,
    '--tg-titlebar-bg': c.titlebar,
    '--tg-chat-bg': c.chat,
    '--tg-header-bg': c.header,
    '--tg-card-bg': c.card,
    '--tg-modal-bg': c.modal,
    '--tg-input-bg': c.input,
    '--tg-search-bg': c.search,
    '--tg-hover': c.hover,
    '--tg-divider': c.divider,
    '--tg-bubble-in': c.bubbleIn,
    '--tg-bubble-out': c.bubbleOut,
    '--tg-bubble-out-text': c.bubbleOutText,
    '--tg-bubble-out-meta': c.bubbleOutMeta,
    '--tg-menu-bg': c.menu,
    '--tg-pinned-bg': c.pinned,
    '--tg-settings-bg': c.settings,
    '--tg-composer-bg': c.composer,
    '--tg-scrim': c.scrim,
    '--tg-green': '#4fae4e',
    '--tg-red': '#e53935',
    '--tg-amber': '#f5a623',
    '--tg-blue': accent,

    // Compatibility aliases used by shared components and the logo.
    '--md-primary': accent,
    '--md-on-primary': onAccent,
    '--md-primary-container': accentSoft,
    '--md-on-primary-container': dark ? accentLight : accentPressed,
    '--md-secondary': accentHover,
    '--md-on-secondary': onAccent,
    '--md-secondary-container': accentSoftStrong,
    '--md-on-secondary-container': dark ? accentLight : accentPressed,
    '--md-tertiary': accentLight,
    '--md-on-tertiary': onAccent,
    '--md-tertiary-container': accentSoft,
    '--md-on-tertiary-container': dark ? accentLight : accentPressed,
    '--md-error': '#e53935',
    '--md-on-error': '#ffffff',
    '--md-error-container': dark ? '#4b1f1f' : '#fde7e6',
    '--md-on-error-container': dark ? '#ffb4ab' : '#8c1d18',
    '--md-surface': c.sidebar,
    '--md-on-surface': c.text,
    '--md-surface-variant': c.hover,
    '--md-on-surface-variant': c.secondary,
    '--md-outline': c.secondary,
    '--md-outline-variant': c.divider,
    '--md-inverse-surface': dark ? '#f5f5f5' : '#2b2b2b',
    '--md-inverse-on-surface': dark ? '#1a1a1a' : '#ffffff',
    '--md-inverse-primary': accentLight,
    '--md-surface-dim': dark ? '#151515' : '#e7e7e7',
    '--md-surface-container-lowest': c.sidebar,
    '--md-surface-container-low': c.settings,
    '--md-surface-container': c.input,
    '--md-surface-container-high': dark ? '#303030' : '#e9eaec',
    '--md-surface-container-highest': dark ? '#383838' : '#e1e3e5',
    '--md-scrim': '#000000',
    '--seed': seedHex
  }
}

export function applyTheme(
  settings: AppSettings,
  accentColor: string
): {
  dark: boolean
  surface: string
  symbol: string
} {
  const seed = settings.useSystemAccent ? accentColor : settings.seedColor
  const dark = resolveDark(settings.themeMode)
  const tokens = tokenMap(dark, seed)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.colorScheme = dark ? 'dark' : 'light'
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value)
  }
  return {
    dark,
    surface: tokens['--tg-titlebar-bg'],
    symbol: dark ? '#f5f5f5' : '#1a1a1a'
  }
}

export function seedSwatches(): string[] {
  return ['#3390EC', '#0078D7', '#8774E1', '#E17076', '#7BC862', '#E5A54B', '#65AADD', '#A695E7']
}

export function hctFrom(hex: string): Hct {
  return Hct.fromInt(argbFromHex(hex))
}
