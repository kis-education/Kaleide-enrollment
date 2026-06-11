import { getDocumentBytes } from '../api';

/**
 * CLI 82 / KAL-NEW-5 (Anexo A Opción A): proxy de bytes en el cliente.
 *
 * Pide los bytes de un documento PRIVADO de Drive al backend vía `getDocument`
 * (gateado por resume_token O signing_token + guard IDOR de propiedad) y los
 * reconstruye en memoria con URL.createObjectURL. El fichero nunca toca un
 * origen público — sustituye los antiguos enlaces públicos de Drive.
 *
 * El caller es responsable de `URL.revokeObjectURL(url)` cuando ya no lo
 * necesita (típicamente al desmontar el componente).
 *
 * @param {{file_id:string, resume_token?:string, signing_token?:string, n?:string, recovered_email?:string}} params
 * @returns {Promise<{url:string, mimeType:string, filename:string}>}
 */
export async function fetchDocumentObjectUrl({ file_id, resume_token, signing_token, n, recovered_email }) {
  // WPERF-1: pasa por la caché de bytes (getDocumentBytes) — si prefetchDocuments ya
  // calentó este file_id, la promesa está resuelta y el object URL se crea al instante.
  // IDENTITY-COMPLETION (#30): `n` (email_id del enlace) + recovered_email viajan para que
  // getDocument_ resuelva el signing_token server-side bajo resume_token (PDF de firma).
  const { base64, mimeType, filename } = await getDocumentBytes({
    file_id,
    resume_token,
    signing_token,
    n,
    recovered_email,
  });
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url   = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }));
  return { url, mimeType, filename };
}

/**
 * Abre un documento privado en una pestaña nueva vía el proxy de bytes.
 * Revoca el object URL tras un margen para que la pestaña tenga tiempo de
 * cargarlo.
 *
 * @param {{file_id:string, resume_token?:string, signing_token?:string}} params
 */
export async function openDocument(params) {
  const { url } = await fetchDocumentObjectUrl(params);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
