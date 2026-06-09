/**
 * Curated ISO 3166-1 alpha-2 country list for use in selects.
 * value = country code stored in DB; label = display name; dial = international
 * calling code (E.164 country code, sin '+'). Sorted alphabetically by label.
 *
 * CLI PHONE-VAL (DL-E40, calidad en la frontera): `dial` define el SET CERRADO
 * de prefijos telefónicos aceptados por el wizard — un número internacional cuyo
 * country-calling-code no esté en este catálogo se rechaza (ver utils/phone.js).
 *
 * Fuente canónica futura = columna del código telefónico en la tabla AppSheet de
 * países (alta MANUAL de Diego, ver TODO abajo). Mientras esa columna no exista,
 * `dial` vive aquí hardcodeado y el validador DEGRADA DEFENSIVO: si una entrada no
 * tiene `dial`, NO se aplica el filtro de set cerrado para ese prefijo (se cae al
 * validador E.164 puro) en vez de rechazar números legítimos.
 *
 * TODO(Diego) — columna AppSheet del código telefónico en la tabla de países.
 *   Cabecera (tab-separated) a añadir a mano:
 *     country_id\tphone_calling_code
 *   Una vez exista y se sirva al wizard, `dial` debe leerse de ahí (no de este
 *   literal). La falta de columna NO congela el desarrollo: el set cerrado opera
 *   hoy con estos valores hardcodeados.
 */
export const COUNTRIES = [
  { value: 'AF', label: 'Afghanistan', dial: '93' },
  { value: 'AL', label: 'Albania', dial: '355' },
  { value: 'DZ', label: 'Algeria', dial: '213' },
  { value: 'AD', label: 'Andorra', dial: '376' },
  { value: 'AO', label: 'Angola', dial: '244' },
  { value: 'AR', label: 'Argentina', dial: '54' },
  { value: 'AM', label: 'Armenia', dial: '374' },
  { value: 'AU', label: 'Australia', dial: '61' },
  { value: 'AT', label: 'Austria', dial: '43' },
  { value: 'AZ', label: 'Azerbaijan', dial: '994' },
  { value: 'BH', label: 'Bahrain', dial: '973' },
  { value: 'BD', label: 'Bangladesh', dial: '880' },
  { value: 'BY', label: 'Belarus', dial: '375' },
  { value: 'BE', label: 'Belgium', dial: '32' },
  { value: 'BZ', label: 'Belize', dial: '501' },
  { value: 'BO', label: 'Bolivia', dial: '591' },
  { value: 'BA', label: 'Bosnia and Herzegovina', dial: '387' },
  { value: 'BR', label: 'Brazil', dial: '55' },
  { value: 'BG', label: 'Bulgaria', dial: '359' },
  { value: 'CM', label: 'Cameroon', dial: '237' },
  { value: 'CA', label: 'Canada', dial: '1' },
  { value: 'CL', label: 'Chile', dial: '56' },
  { value: 'CN', label: 'China', dial: '86' },
  { value: 'CO', label: 'Colombia', dial: '57' },
  { value: 'CR', label: 'Costa Rica', dial: '506' },
  { value: 'HR', label: 'Croatia', dial: '385' },
  { value: 'CU', label: 'Cuba', dial: '53' },
  { value: 'CY', label: 'Cyprus', dial: '357' },
  { value: 'CZ', label: 'Czech Republic', dial: '420' },
  { value: 'DK', label: 'Denmark', dial: '45' },
  { value: 'DO', label: 'Dominican Republic', dial: '1' },
  { value: 'EC', label: 'Ecuador', dial: '593' },
  { value: 'EG', label: 'Egypt', dial: '20' },
  { value: 'SV', label: 'El Salvador', dial: '503' },
  { value: 'EE', label: 'Estonia', dial: '372' },
  { value: 'ET', label: 'Ethiopia', dial: '251' },
  { value: 'FI', label: 'Finland', dial: '358' },
  { value: 'FR', label: 'France', dial: '33' },
  { value: 'GE', label: 'Georgia', dial: '995' },
  { value: 'DE', label: 'Germany', dial: '49' },
  { value: 'GH', label: 'Ghana', dial: '233' },
  { value: 'GR', label: 'Greece', dial: '30' },
  { value: 'GT', label: 'Guatemala', dial: '502' },
  { value: 'HN', label: 'Honduras', dial: '504' },
  { value: 'HK', label: 'Hong Kong', dial: '852' },
  { value: 'HU', label: 'Hungary', dial: '36' },
  { value: 'IS', label: 'Iceland', dial: '354' },
  { value: 'IN', label: 'India', dial: '91' },
  { value: 'ID', label: 'Indonesia', dial: '62' },
  { value: 'IR', label: 'Iran', dial: '98' },
  { value: 'IQ', label: 'Iraq', dial: '964' },
  { value: 'IE', label: 'Ireland', dial: '353' },
  { value: 'IL', label: 'Israel', dial: '972' },
  { value: 'IT', label: 'Italy', dial: '39' },
  { value: 'CI', label: 'Ivory Coast', dial: '225' },
  { value: 'JM', label: 'Jamaica', dial: '1' },
  { value: 'JP', label: 'Japan', dial: '81' },
  { value: 'JO', label: 'Jordan', dial: '962' },
  { value: 'KZ', label: 'Kazakhstan', dial: '7' },
  { value: 'KE', label: 'Kenya', dial: '254' },
  { value: 'KW', label: 'Kuwait', dial: '965' },
  { value: 'LV', label: 'Latvia', dial: '371' },
  { value: 'LB', label: 'Lebanon', dial: '961' },
  { value: 'LI', label: 'Liechtenstein', dial: '423' },
  { value: 'LT', label: 'Lithuania', dial: '370' },
  { value: 'LU', label: 'Luxembourg', dial: '352' },
  { value: 'MY', label: 'Malaysia', dial: '60' },
  { value: 'MT', label: 'Malta', dial: '356' },
  { value: 'MX', label: 'Mexico', dial: '52' },
  { value: 'MD', label: 'Moldova', dial: '373' },
  { value: 'MC', label: 'Monaco', dial: '377' },
  { value: 'ME', label: 'Montenegro', dial: '382' },
  { value: 'MA', label: 'Morocco', dial: '212' },
  { value: 'MZ', label: 'Mozambique', dial: '258' },
  { value: 'NL', label: 'Netherlands', dial: '31' },
  { value: 'NZ', label: 'New Zealand', dial: '64' },
  { value: 'NI', label: 'Nicaragua', dial: '505' },
  { value: 'NG', label: 'Nigeria', dial: '234' },
  { value: 'MK', label: 'North Macedonia', dial: '389' },
  { value: 'NO', label: 'Norway', dial: '47' },
  { value: 'PK', label: 'Pakistan', dial: '92' },
  { value: 'PA', label: 'Panama', dial: '507' },
  { value: 'PY', label: 'Paraguay', dial: '595' },
  { value: 'PE', label: 'Peru', dial: '51' },
  { value: 'PH', label: 'Philippines', dial: '63' },
  { value: 'PL', label: 'Poland', dial: '48' },
  { value: 'PT', label: 'Portugal', dial: '351' },
  { value: 'QA', label: 'Qatar', dial: '974' },
  { value: 'RO', label: 'Romania', dial: '40' },
  { value: 'RU', label: 'Russia', dial: '7' },
  { value: 'SA', label: 'Saudi Arabia', dial: '966' },
  { value: 'SN', label: 'Senegal', dial: '221' },
  { value: 'RS', label: 'Serbia', dial: '381' },
  { value: 'SG', label: 'Singapore', dial: '65' },
  { value: 'SK', label: 'Slovakia', dial: '421' },
  { value: 'SI', label: 'Slovenia', dial: '386' },
  { value: 'ZA', label: 'South Africa', dial: '27' },
  { value: 'KR', label: 'South Korea', dial: '82' },
  { value: 'ES', label: 'Spain', dial: '34' },
  { value: 'LK', label: 'Sri Lanka', dial: '94' },
  { value: 'SE', label: 'Sweden', dial: '46' },
  { value: 'CH', label: 'Switzerland', dial: '41' },
  { value: 'SY', label: 'Syria', dial: '963' },
  { value: 'TW', label: 'Taiwan', dial: '886' },
  { value: 'TZ', label: 'Tanzania', dial: '255' },
  { value: 'TH', label: 'Thailand', dial: '66' },
  { value: 'TN', label: 'Tunisia', dial: '216' },
  { value: 'TR', label: 'Turkey', dial: '90' },
  { value: 'UA', label: 'Ukraine', dial: '380' },
  { value: 'AE', label: 'United Arab Emirates', dial: '971' },
  { value: 'GB', label: 'United Kingdom', dial: '44' },
  { value: 'US', label: 'United States', dial: '1' },
  { value: 'UY', label: 'Uruguay', dial: '598' },
  { value: 'UZ', label: 'Uzbekistan', dial: '998' },
  { value: 'VE', label: 'Venezuela', dial: '58' },
  { value: 'VN', label: 'Vietnam', dial: '84' },
  { value: 'YE', label: 'Yemen', dial: '967' },
  { value: 'ZW', label: 'Zimbabwe', dial: '263' },
];

/**
 * Set cerrado de prefijos telefónicos internacionales (E.164 country codes)
 * derivado del catálogo. Fuente de verdad para validar teléfonos en la entrada.
 * Degradación defensiva: las entradas sin `dial` simplemente no contribuyen al
 * set (no se puede rechazar contra un prefijo que no conocemos).
 */
export const COUNTRY_DIAL_CODES = new Set(
  COUNTRIES.map(c => c.dial).filter(Boolean)
);
