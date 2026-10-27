import { app } from 'electron'
import {
  getCountryCallingCode,
  isSupportedCountry,
  type CountryCode
} from 'libphonenumber-js/min'
import type { DetectedCountry } from '../shared/types'

function regionFromLocale(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).region?.toUpperCase()
  } catch {
    return undefined
  }
}

function countryName(code: CountryCode): string {
  try {
    const display = new Intl.DisplayNames(['es'], { type: 'region' })
    return display.of(code) ?? code
  } catch {
    return code
  }
}

export function detectCountry(): DetectedCountry | undefined {
  let code = ''

  try {
    code = app.getLocaleCountryCode().toUpperCase()
  } catch {
    // Not available on every platform.
  }

  if (!code) {
    const candidates = [app.getSystemLocale(), app.getLocale()]
    for (const locale of candidates) {
      const region = regionFromLocale(locale)
      if (region) {
        code = region
        break
      }
    }
  }

  if (!isSupportedCountry(code)) return undefined

  try {
    return {
      code,
      name: countryName(code),
      dialCode: `+${getCountryCallingCode(code)}`
    }
  } catch {
    return undefined
  }
}
