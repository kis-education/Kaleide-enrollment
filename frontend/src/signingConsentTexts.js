/**
 * Consentimientos GDPR canónicos del flujo de firma (Step 9 — S-GDPR).
 *
 * Lista canónica per DL-E27 §1 (kis-app enr-module-design-log.md): 7 decisiones
 * por guardian. `GDPR_SCHOOL` es bloqueante (rechazarlo impide avanzar a review/sign).
 * Los demás (image rights × 4 usos, comms, platform groups) son opcionales.
 *
 * DOS CAMPOS DISTINTOS, y confundirlos fue el error que esto corrige (DL-S111):
 *   - `id`   = identidad DE PANTALLA. Clave de React, clave del estado del formulario y
 *              del `id`/`htmlFor` de cada casilla. NO viaja al servidor. Es única por
 *              casilla, que es lo que la pantalla necesita.
 *   - `code` = `consent_type_code` del CATÁLOGO (`config/sys-consent-types.json`), que es
 *              lo que se transmite. Los cuatro usos de imagen comparten `IMAGE_RIGHTS` y
 *              se distinguen por `consent_use`, que es exactamente lo que el catálogo
 *              declara (`requires_use: true`, `granularity: "per_use"`).
 *
 * Antes `code` hacía los dos papeles a la vez, así que para tener casillas distintas se
 * inventaron cuatro códigos planos (`IMAGE_RIGHTS_INTERNAL_GALLERY`…) que NO están en el
 * catálogo. Eso metió 794 fichas fuera de catálogo en el registro de consentimientos.
 * El catálogo no se ensancha para que quepa lo que un escritor metió mal: se arregla el
 * escritor (DL-S111 §3).
 *
 * El texto mostrado se envía como `consent_text_shown` (auditoría GDPR — debe coincidir
 * con lo que el guardian vio).
 *
 * Stage 1: textos hardcoded aquí (Capa 2 SaaS per DL-E27 §1 "se hardcodea en el
 * frontend"). TODO Fase 2: fetcher backend `enr.getConsentTexts` para centralizar
 * versión + i18n server-side (DL-E27 §1 menciona config/consent-steps.json futuro).
 */

export const SIGNING_CONSENT_TEXT_VERSION = 'v1';

export const SIGNING_CONSENTS = [
  {
    id:   'GDPR_SCHOOL',
    code: 'GDPR_SCHOOL',
    consent_use: null,
    blocking: true,
    label: {
      es: 'Tratamiento de datos personales (RGPD) — obligatorio',
      en: 'Personal data processing (GDPR) — required',
    },
    text: {
      es: 'Consiento la recogida y el tratamiento de los datos personales del alumno y de la familia por parte de Kaleide International School, conforme a la Política de Privacidad del centro y a la legislación de protección de datos aplicable (RGPD y LOPDGDD). Este consentimiento es necesario para tramitar la matrícula.',
      en: "I consent to the collection and processing of the student's and family's personal data by Kaleide International School, in accordance with the school's Privacy Policy and applicable data protection legislation (GDPR). This consent is required to process the enrolment.",
    },
  },
  {
    id:   'IMAGE_RIGHTS_INTERNAL_GALLERY',
    code: 'IMAGE_RIGHTS',
    consent_use: 'INTERNAL_GALLERY',
    blocking: false,
    label: {
      es: 'Uso de imágenes — galerías internas',
      en: 'Image use — internal galleries',
    },
    text: {
      es: 'Autorizo el uso de imágenes del alumno en galerías internas del centro (intranet, álbumes de acceso restringido a la comunidad educativa).',
      en: 'I authorise the use of the student’s images in the school’s internal galleries (intranet, albums restricted to the school community).',
    },
  },
  {
    id:   'IMAGE_RIGHTS_NEWSLETTER',
    code: 'IMAGE_RIGHTS',
    consent_use: 'NEWSLETTER',
    blocking: false,
    label: {
      es: 'Uso de imágenes — newsletter',
      en: 'Image use — newsletter',
    },
    text: {
      es: 'Autorizo el uso de imágenes del alumno en el boletín informativo (newsletter) del centro.',
      en: 'I authorise the use of the student’s images in the school newsletter.',
    },
  },
  {
    id:   'IMAGE_RIGHTS_SOCIAL_MEDIA',
    code: 'IMAGE_RIGHTS',
    consent_use: 'SOCIAL_MEDIA',
    blocking: false,
    label: {
      es: 'Uso de imágenes — redes sociales',
      en: 'Image use — social media',
    },
    text: {
      es: 'Autorizo el uso de imágenes del alumno en las redes sociales oficiales del centro.',
      en: 'I authorise the use of the student’s images on the school’s official social media channels.',
    },
  },
  {
    id:   'IMAGE_RIGHTS_WEB_PUBLIC',
    code: 'IMAGE_RIGHTS',
    consent_use: 'WEB_PUBLIC',
    blocking: false,
    label: {
      es: 'Uso de imágenes — web pública',
      en: 'Image use — public website',
    },
    text: {
      es: 'Autorizo el uso de imágenes del alumno en la página web pública del centro.',
      en: 'I authorise the use of the student’s images on the school’s public website.',
    },
  },
  {
    id:   'COMMERCIAL_COMMS',
    code: 'COMMERCIAL_COMMS',
    consent_use: null,
    blocking: false,
    label: {
      es: 'Comunicaciones comerciales',
      en: 'Commercial communications',
    },
    text: {
      es: 'Consiento recibir comunicaciones comerciales del centro (ofertas, eventos abiertos, actividades). Puedo revocar este consentimiento en cualquier momento (Art. 7.4 RGPD).',
      en: 'I consent to receive commercial communications from the school (offers, open events, activities). I may withdraw this consent at any time (Art. 7.4 GDPR).',
    },
  },
  {
    id:   'PLATFORM_GROUPS',
    code: 'PLATFORM_GROUPS',
    consent_use: null,
    blocking: false,
    label: {
      es: 'Grupos de comunicación de clase',
      en: 'Class communication groups',
    },
    text: {
      es: 'Consiento la participación en grupos de comunicación informal de la clase (p.ej. grupos de mensajería entre familias). Puedo revocar este consentimiento en cualquier momento (Art. 7.4 RGPD).',
      en: 'I consent to participation in informal class communication groups (e.g. messaging groups among families). I may withdraw this consent at any time (Art. 7.4 GDPR).',
    },
  },
];
